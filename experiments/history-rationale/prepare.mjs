#!/usr/bin/env node
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

export const HISTORY_RATIONALE_FIXTURE_PROTOCOL =
  'anet-memory/history-rationale-fixture/1';

async function main(argv) {
  const args = parseArgs(argv);
  const memoryRoot = path.resolve(required(args, 'memory-root'));
  const runId = required(args, 'run-id');
  const project = args.project ?? 'anet-memory-history-test';

  validateRunId(runId);
  await requireEmptyOrMissing(memoryRoot);

  const ids = {
    task: runId + '-task',
    oldDecision: runId + '-d1',
    currentDecision: runId + '-d2',
    rejectedAlternative: runId + '-r1',
    rejectionDecision: runId + '-dr',
    oldEvidence: runId + '-e1',
    currentEvidence: runId + '-e2',
    rejectionEvidence: runId + '-er',
  };

  const artifacts = [
    createMemoryArtifact({
      artifactId: ids.task,
      kind: 'task',
      project,
      subject: 'fresh-chat pollution resistance and rationale recovery',
      summary:
        'prove current-state filtering plus explicit historical rationale recovery in a fresh consumer',
      status: 'OPEN',
      context: 'synthetic acceptance fixture for github:issue/46',
      relations: [
        { type: 'depends_on', target: ids.oldDecision },
        { type: 'depends_on', target: ids.rejectedAlternative },
      ],
      provenance: ['github:issue/46', 'fixture:' + runId],
    }),
    createMemoryArtifact({
      artifactId: ids.oldDecision,
      kind: 'decision',
      project,
      subject: 'fixture retrieval policy',
      summary:
        'historical decision D1 retained only for explicit history/rationale queries',
      status: 'HISTORICAL',
      context: 'synthetic acceptance fixture for github:issue/46',
      relations: [{ type: 'evidence', target: ids.oldEvidence }],
      provenance: ['github:issue/46', 'fixture:D1'],
    }),
    createMemoryArtifact({
      artifactId: ids.currentDecision,
      kind: 'decision',
      project,
      subject: 'fixture retrieval policy',
      summary:
        'current decision D2 replaces D1 and excludes historical alternatives from current state',
      status: 'ACTIVE',
      context: 'synthetic acceptance fixture for github:issue/46',
      relations: [{ type: 'evidence', target: ids.currentEvidence }],
      provenance: ['github:issue/46', 'fixture:D2'],
    }),
    createMemoryArtifact({
      artifactId: ids.rejectedAlternative,
      kind: 'claim',
      project,
      subject: 'fixture rejected retrieval alternative',
      summary:
        'rejected alternative R1 that must never reappear as a current accepted fact',
      status: 'HISTORICAL',
      context: 'synthetic acceptance fixture for github:issue/46',
      relations: [{ type: 'rejected_by', target: ids.rejectionDecision }],
      provenance: ['github:issue/46', 'fixture:R1'],
    }),
    createMemoryArtifact({
      artifactId: ids.rejectionDecision,
      kind: 'decision',
      project,
      subject: 'fixture rejection rationale',
      summary:
        'DR rejects R1 because reintroducing rejected history would violate current-state filtering',
      status: 'ACTIVE',
      context: 'synthetic acceptance fixture for github:issue/46',
      relations: [{ type: 'evidence', target: ids.rejectionEvidence }],
      provenance: ['github:issue/46', 'fixture:DR'],
    }),
    createMemoryArtifact({
      artifactId: ids.oldEvidence,
      kind: 'evidence',
      project,
      subject: 'fixture D1 historical evidence',
      summary:
        'E1 is historical evidence retained to explain the old decision when history is requested',
      status: 'HISTORICAL',
      context: 'synthetic acceptance fixture for github:issue/46',
      relations: [],
      provenance: ['github:issue/46', 'fixture:E1'],
    }),
    createMemoryArtifact({
      artifactId: ids.currentEvidence,
      kind: 'evidence',
      project,
      subject: 'fixture D2 replacement evidence',
      summary:
        'E2 records why D2 is the current replacement used by normal bootstrap',
      status: 'ACTIVE',
      context: 'synthetic acceptance fixture for github:issue/46',
      relations: [],
      provenance: ['github:issue/46', 'fixture:E2'],
    }),
    createMemoryArtifact({
      artifactId: ids.rejectionEvidence,
      kind: 'evidence',
      project,
      subject: 'fixture R1 rejection evidence',
      summary:
        'ER explains that R1 is rejected because current-state bootstrap must not resurrect rejected alternatives',
      status: 'ACTIVE',
      context: 'synthetic acceptance fixture for github:issue/46',
      relations: [],
      provenance: ['github:issue/46', 'fixture:ER'],
    }),
  ];

  for (const artifact of artifacts) {
    await appendMemoryArtifact(memoryRoot, artifact);
  }

  const createdAt = [
    '2026-10-08T00:10:00.000Z',
    '2026-10-08T00:10:01.000Z',
    '2026-10-08T00:10:02.000Z',
    '2026-10-08T00:10:03.000Z',
    '2026-10-08T00:10:04.000Z',
    '2026-10-08T00:10:05.000Z',
    '2026-10-08T00:10:06.000Z',
    '2026-10-08T00:10:07.000Z',
    '2026-10-08T00:10:08.000Z',
  ];

  const events = [
    createMemoryEvent({
      eventId: runId + '-task-1',
      artifactId: ids.task,
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'experiment-fixture',
      provenance: ['github:issue/46', 'fixture:' + runId],
      createdAt: createdAt[0],
    }),
    createMemoryEvent({
      eventId: runId + '-d1-1',
      artifactId: ids.oldDecision,
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'experiment-fixture',
      provenance: ['github:issue/46', 'fixture:D1'],
      createdAt: createdAt[1],
    }),
    createMemoryEvent({
      eventId: runId + '-d1-2',
      artifactId: ids.oldDecision,
      sequence: 2,
      previousEventId: runId + '-d1-1',
      action: 'supersede',
      authority: 'author',
      actor: 'experiment-fixture',
      provenance: ['github:issue/46', 'fixture:D1->D2'],
      replacementArtifactId: ids.currentDecision,
      createdAt: createdAt[2],
    }),
    createMemoryEvent({
      eventId: runId + '-d2-1',
      artifactId: ids.currentDecision,
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'experiment-fixture',
      provenance: ['github:issue/46', 'fixture:D2'],
      createdAt: createdAt[3],
    }),
    createMemoryEvent({
      eventId: runId + '-r1-1',
      artifactId: ids.rejectedAlternative,
      sequence: 1,
      action: 'reject',
      authority: 'author',
      actor: 'experiment-fixture',
      provenance: ['github:issue/46', 'fixture:R1'],
      createdAt: createdAt[4],
    }),
    createMemoryEvent({
      eventId: runId + '-dr-1',
      artifactId: ids.rejectionDecision,
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'experiment-fixture',
      provenance: ['github:issue/46', 'fixture:DR'],
      createdAt: createdAt[5],
    }),
    createMemoryEvent({
      eventId: runId + '-e1-1',
      artifactId: ids.oldEvidence,
      sequence: 1,
      action: 'observe',
      authority: 'external',
      actor: 'experiment-fixture',
      provenance: ['github:issue/46', 'fixture:E1'],
      createdAt: createdAt[6],
    }),
    createMemoryEvent({
      eventId: runId + '-e2-1',
      artifactId: ids.currentEvidence,
      sequence: 1,
      action: 'observe',
      authority: 'external',
      actor: 'experiment-fixture',
      provenance: ['github:issue/46', 'fixture:E2'],
      createdAt: createdAt[7],
    }),
    createMemoryEvent({
      eventId: runId + '-er-1',
      artifactId: ids.rejectionEvidence,
      sequence: 1,
      action: 'observe',
      authority: 'external',
      actor: 'experiment-fixture',
      provenance: ['github:issue/46', 'fixture:ER'],
      createdAt: createdAt[8],
    }),
  ];

  for (const event of events) {
    await appendMemoryEvent(memoryRoot, event);
  }

  process.stdout.write(JSON.stringify({
    protocol: HISTORY_RATIONALE_FIXTURE_PROTOCOL,
    run_id: runId,
    project,
    memory_root: memoryRoot,
    artifact_ids: ids,
    artifact_count: artifacts.length,
    event_count: events.length,
  }, null, 2) + '\n');
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

export { main as prepareHistoryRationaleFixture };
