#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  appendMemoryArtifact,
  createMemoryArtifact,
} from '../../src/memory-artifacts.mjs';
import {
  appendMemoryEvent,
  createMemoryEvent,
} from '../../src/memory-events.mjs';

export const OVERSIZED_PROJECTION_FIXTURE_PROTOCOL =
  'anet-memory/oversized-projection-fixture/1';

const DEFAULT_PROJECT = 'anet-memory-oversized-benchmark';
const DEFAULT_NOISE_COUNT = 32;
const DEFAULT_NOISE_BYTES = 5000;
const ALLOWED_VERDICTS = new Set(['HOLD', 'RELEASE']);

export function canonicalAnswerJson({ verdict, evidenceToken }) {
  return JSON.stringify({
    evidence_token: evidenceToken,
    verdict,
  });
}

export function answerCommitment(answer) {
  return createHash('sha256')
    .update(canonicalAnswerJson(answer), 'utf8')
    .digest('hex');
}

async function main(argv) {
  const args = parseArgs(argv);
  const memoryRoot = path.resolve(required(args, 'memory-root'));
  const runId = required(args, 'run-id');
  const project = args.project ?? DEFAULT_PROJECT;
  const noiseCount = integerArg(args, 'noise-count', DEFAULT_NOISE_COUNT, 1);
  const noiseBytes = integerArg(args, 'noise-bytes', DEFAULT_NOISE_BYTES, 512);

  validateRunId(runId);
  await requireEmptyOrMissing(memoryRoot);

  const verdict = args.verdict ?? randomVerdict();
  if (!ALLOWED_VERDICTS.has(verdict)) {
    throw new Error('--verdict must be HOLD or RELEASE');
  }

  const evidenceToken = args['evidence-token'] ?? (
    'EV-' + randomBytes(12).toString('hex')
  );
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(evidenceToken)) {
    throw new Error('--evidence-token contains unsupported characters or length');
  }

  const ids = {
    task: runId + '-task',
    oldDecision: runId + '-d-old',
    currentDecision: runId + '-d-current',
    rejectedAlternative: runId + '-r-rejected',
    rejectionDecision: runId + '-d-reject',
    currentEvidence: runId + '-e-current',
    rejectionEvidence: runId + '-e-reject',
  };

  const artifacts = [
    createMemoryArtifact({
      artifactId: ids.task,
      kind: 'task',
      project,
      subject: 'Project Aurora authoritative deployment verdict benchmark',
      summary:
        'Determine the authoritative deployment verdict and evidence token from bounded relation-native ANet projection.',
      status: 'OPEN',
      context: 'oversized projection benchmark #49',
      relations: [
        { type: 'depends_on', target: ids.oldDecision },
        { type: 'depends_on', target: ids.rejectedAlternative },
      ],
      provenance: ['github:issue/49', 'benchmark:' + runId],
    }),
    createMemoryArtifact({
      artifactId: ids.oldDecision,
      kind: 'decision',
      project,
      subject: 'Project Aurora deployment verdict',
      summary:
        'Legacy deployment decision retained only as superseded history. It is not authoritative current state.',
      status: 'HISTORICAL',
      context: 'oversized projection benchmark #49',
      relations: [],
      provenance: ['github:issue/49', 'benchmark:legacy-decision'],
    }),
    createMemoryArtifact({
      artifactId: ids.currentDecision,
      kind: 'decision',
      project,
      subject: 'Project Aurora deployment verdict',
      summary:
        'AUTHORITATIVE_VERDICT=' + verdict +
        '. This is the current accepted deployment decision for the benchmark.',
      status: 'ACTIVE',
      context: 'oversized projection benchmark #49',
      relations: [{ type: 'evidence', target: ids.currentEvidence }],
      provenance: ['github:issue/49', 'benchmark:current-decision'],
    }),
    createMemoryArtifact({
      artifactId: ids.rejectedAlternative,
      kind: 'hypothesis',
      project,
      subject: 'Project Aurora deployment shortcut',
      summary:
        'Rejected alternative: infer the deployment verdict from text similarity or disconnected candidate notes.',
      status: 'HISTORICAL',
      context: 'oversized projection benchmark #49',
      relations: [{ type: 'rejected_by', target: ids.rejectionDecision }],
      provenance: ['github:issue/49', 'benchmark:rejected-alternative'],
    }),
    createMemoryArtifact({
      artifactId: ids.rejectionDecision,
      kind: 'decision',
      project,
      subject: 'Project Aurora rejection rationale',
      summary:
        'Disconnected lexical similarity is not authority; only the structurally connected current decision and evidence may answer the benchmark.',
      status: 'ACTIVE',
      context: 'oversized projection benchmark #49',
      relations: [{ type: 'evidence', target: ids.rejectionEvidence }],
      provenance: ['github:issue/49', 'benchmark:rejection-decision'],
    }),
    createMemoryArtifact({
      artifactId: ids.currentEvidence,
      kind: 'evidence',
      project,
      subject: 'Project Aurora authoritative deployment evidence',
      summary:
        'AUTHORITATIVE_EVIDENCE_TOKEN=' + evidenceToken +
        '. This observed evidence supports the current deployment decision.',
      status: 'ACTIVE',
      context: 'oversized projection benchmark #49',
      relations: [],
      provenance: ['github:issue/49', 'benchmark:authoritative-evidence'],
    }),
    createMemoryArtifact({
      artifactId: ids.rejectionEvidence,
      kind: 'evidence',
      project,
      subject: 'Project Aurora benchmark rejection evidence',
      summary:
        'Benchmark rule: disconnected distractor text must not override relation-native provenance.',
      status: 'ACTIVE',
      context: 'oversized projection benchmark #49',
      relations: [],
      provenance: ['github:issue/49', 'benchmark:rejection-evidence'],
    }),
  ];

  for (let index = 0; index < noiseCount; index += 1) {
    const id = runId + '-noise-' + String(index).padStart(3, '0');
    artifacts.push(createMemoryArtifact({
      artifactId: id,
      kind: 'note',
      project,
      subject: 'Project Aurora authoritative deployment verdict evidence token benchmark',
      summary: makeNoiseSummary(index, noiseBytes),
      status: 'ACTIVE',
      context: 'oversized disconnected distractor',
      relations: [],
      provenance: ['github:issue/49', 'benchmark:distractor:' + index],
    }));
  }

  for (const artifact of artifacts) {
    await appendMemoryArtifact(memoryRoot, artifact);
  }

  const events = [];
  let tick = 0;
  const at = () => {
    const value = new Date(Date.UTC(2026, 9, 8, 2, 0, tick));
    tick += 1;
    return value.toISOString();
  };

  events.push(
    acceptEvent(runId + '-task-1', ids.task, at()),
    acceptEvent(runId + '-d-old-1', ids.oldDecision, at()),
    createMemoryEvent({
      eventId: runId + '-d-old-2',
      artifactId: ids.oldDecision,
      sequence: 2,
      previousEventId: runId + '-d-old-1',
      action: 'supersede',
      authority: 'author',
      actor: 'benchmark-fixture',
      replacementArtifactId: ids.currentDecision,
      provenance: ['github:issue/49', 'benchmark:old->current'],
      createdAt: at(),
    }),
    acceptEvent(runId + '-d-current-1', ids.currentDecision, at()),
    createMemoryEvent({
      eventId: runId + '-r-rejected-1',
      artifactId: ids.rejectedAlternative,
      sequence: 1,
      action: 'reject',
      authority: 'author',
      actor: 'benchmark-fixture',
      provenance: ['github:issue/49', 'benchmark:rejected-alternative'],
      createdAt: at(),
    }),
    acceptEvent(runId + '-d-reject-1', ids.rejectionDecision, at()),
    observeEvent(runId + '-e-current-1', ids.currentEvidence, at()),
    observeEvent(runId + '-e-reject-1', ids.rejectionEvidence, at()),
  );

  for (let index = 0; index < noiseCount; index += 1) {
    const artifactId = runId + '-noise-' + String(index).padStart(3, '0');
    events.push(acceptEvent(
      artifactId + '-1',
      artifactId,
      at(),
      ['github:issue/49', 'benchmark:distractor:' + index],
    ));
  }

  for (const event of events) {
    await appendMemoryEvent(memoryRoot, event);
  }

  const answer = { verdict, evidenceToken };

  process.stdout.write(JSON.stringify({
    protocol: OVERSIZED_PROJECTION_FIXTURE_PROTOCOL,
    run_id: runId,
    project,
    memory_root: memoryRoot,
    root_artifact_id: ids.task,
    artifact_count: artifacts.length,
    event_count: events.length,
    noise_count: noiseCount,
    noise_summary_bytes: noiseBytes,
    answer_commitment_sha256: answerCommitment(answer),
    answer_canonical_schema: '{"evidence_token":"...","verdict":"..."}',
  }, null, 2) + '\n');
}

function acceptEvent(eventId, artifactId, createdAt, provenance = ['github:issue/49']) {
  return createMemoryEvent({
    eventId,
    artifactId,
    sequence: 1,
    action: 'accept',
    authority: 'author',
    actor: 'benchmark-fixture',
    provenance,
    createdAt,
  });
}

function observeEvent(eventId, artifactId, createdAt) {
  return createMemoryEvent({
    eventId,
    artifactId,
    sequence: 1,
    action: 'observe',
    authority: 'external',
    actor: 'benchmark-fixture',
    provenance: ['github:issue/49'],
    createdAt,
  });
}

function makeNoiseSummary(index, targetBytes) {
  const plausibleVerdict = index % 2 === 0 ? 'HOLD' : 'RELEASE';
  const prefix =
    'DISTRACTOR_ONLY. Project Aurora authoritative deployment verdict evidence token benchmark. ' +
    'PLAUSIBLE_VERDICT=' + plausibleVerdict + '. ' +
    'FAKE_EVIDENCE_TOKEN=FAKE-' + String(index).padStart(3, '0') + '. ' +
    'This artifact is textually similar but structurally disconnected and must not answer the task. ';
  const filler =
    'aurora deployment verdict evidence token authoritative benchmark candidate disconnected noise ';
  let text = prefix;
  while (Buffer.byteLength(text, 'utf8') < targetBytes) text += filler;
  return text.slice(0, targetBytes);
}

function randomVerdict() {
  return (randomBytes(1)[0] & 1) === 0 ? 'HOLD' : 'RELEASE';
}

async function requireEmptyOrMissing(memoryRoot) {
  try {
    const entries = await readdir(memoryRoot);
    if (entries.length !== 0) {
      throw new Error('memory root must be empty or missing: ' + memoryRoot);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(memoryRoot, { recursive: true });
  }
}

function validateRunId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    throw new Error('run-id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/');
  }
}

function integerArg(args, key, defaultValue, minimum) {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (Array.isArray(value)) throw new Error('--' + key + ' may be supplied only once');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error('--' + key + ' must be an integer >= ' + minimum);
  }
  return parsed;
}

function parseArgs(tokens) {
  const output = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error('unexpected argument: ' + token);
    const key = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('missing value for --' + key);
    }
    if (output[key] !== undefined) {
      throw new Error('--' + key + ' may be supplied only once');
    }
    output[key] = value;
    index += 1;
  }
  return output;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('missing required --' + key);
  }
  return value;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write((error?.stack ?? String(error)) + '\n');
    process.exitCode = 1;
  }
}

export { main as prepareOversizedProjectionFixture };
