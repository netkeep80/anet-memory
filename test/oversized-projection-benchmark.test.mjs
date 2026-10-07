import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { canonicalAnswerJson } from '../experiments/oversized-projection/prepare.mjs';

const prepare = path.resolve('experiments/oversized-projection/prepare.mjs');
const measure = path.resolve('experiments/oversized-projection/measure.mjs');
const snapshot = path.resolve('experiments/fresh-chat-bootstrap/snapshot.mjs');

async function tempRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(
          'process exited ' + code + '\nstdout:\n' + out + '\nstderr:\n' + err
        ));
        return;
      }
      resolve({
        stdout: out,
        parsed: JSON.parse(out),
      });
    });
  });
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function extractValue(summary, key) {
  const match = summary.match(new RegExp(key + '=([^.;\\s]+)'));
  assert.ok(match, 'missing ' + key + ' in summary');
  return match[1];
}

test('oversized corpus benchmark stays bounded and expands only along ANet relations', async (t) => {
  const parent = await tempRoot('anet-oversized-benchmark-');
  const publisherMemory = path.join(parent, 'publisher-memory');
  const exported = path.join(parent, 'exported');
  const consumerMemory = path.join(parent, 'consumer-memory');
  const metaPath = path.join(parent, 'benchmark-meta.json');

  t.after(() => rm(parent, { recursive: true, force: true }));

  const runId = 'oversized-benchmark-test-1';
  const expectedAnswer = {
    verdict: 'HOLD',
    evidenceToken: 'EV-0123456789abcdef',
  };

  const prepared = await runNode(prepare, [
    '--memory-root', publisherMemory,
    '--run-id', runId,
    '--verdict', expectedAnswer.verdict,
    '--evidence-token', expectedAnswer.evidenceToken,
    '--noise-count', '32',
    '--noise-bytes', '5000',
  ]);

  assert.equal(prepared.parsed.artifact_count, 39);
  assert.equal(prepared.parsed.event_count, 40);
  assert.equal(prepared.parsed.noise_count, 32);

  const exportedResult = await runNode(snapshot, [
    'export',
    '--memory-root', publisherMemory,
    '--out', exported,
    '--manifest-id', runId,
    '--project', 'anet-memory-oversized-benchmark',
    '--root-artifact', runId + '-task',
    '--provenance', 'github:issue/49',
  ]);

  assert.equal(exportedResult.parsed.objects.length, 79);

  const manifestPath = path.join(exported, 'manifests', runId + '.json');
  const measured = await runNode(measure, [
    '--bundle-root', exported,
    '--manifest', manifestPath,
    '--prepare-result', path.join(parent, 'prepare-result.json'),
    '--out', metaPath,
    '--projection-max-bytes', '8000',
    '--min-ratio', '10',
  ]).catch(async (error) => {
    // measure consumes a file so persist the already verified prepare stdout, then retry.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(parent, 'prepare-result.json'), prepared.stdout, 'utf8');
    return runNode(measure, [
      '--bundle-root', exported,
      '--manifest', manifestPath,
      '--prepare-result', path.join(parent, 'prepare-result.json'),
      '--out', metaPath,
      '--projection-max-bytes', '8000',
      '--min-ratio', '10',
    ]);
  });

  assert.ok(measured.parsed.corpus_bytes >= 80_000);
  assert.ok(measured.parsed.corpus_to_projection_budget_ratio >= 10);

  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  assert.equal(meta.object_count, 79);
  assert.equal(meta.artifact_count, 39);
  assert.equal(meta.event_count, 40);

  const expectedCommitment = sha256(canonicalAnswerJson(expectedAnswer));
  assert.equal(meta.answer_commitment_sha256, expectedCommitment);

  const imported = await runNode(snapshot, [
    'import',
    '--memory-root', consumerMemory,
    '--bundle-root', exported,
    '--manifest', manifestPath,
  ]);

  assert.equal(imported.parsed.imported.length, 79);
  assert.deepEqual(imported.parsed.missing_semantic_records, []);
  assert.deepEqual(imported.parsed.dangling_relations, []);

  const shallow = await runNode(snapshot, [
    'project',
    '--memory-root', consumerMemory,
    '--project', 'anet-memory-oversized-benchmark',
    '--seed-artifact', runId + '-task',
    '--relation-type', 'depends_on',
    '--relation-type', 'evidence',
    '--max-nodes', '8',
    '--max-bytes', '8000',
    '--max-depth', '0',
  ]);

  assert.equal(shallow.parsed.projection.status, 'OK');
  assert.deepEqual(
    shallow.parsed.projection.nodes.map((item) => item.artifact_id),
    [runId + '-task'],
  );
  assert.deepEqual(shallow.parsed.projection.frontier, [runId + '-d-current']);
  assert.ok(shallow.parsed.projection.redirects.some((item) =>
    item.from === runId + '-d-old' && item.to === runId + '-d-current'
  ));
  assert.ok(shallow.parsed.projection.omitted.policy.some((item) =>
    item.artifact_id === runId + '-r-rejected' &&
    item.reason === 'HISTORICAL_EXCLUDED'
  ));
  assert.ok(shallow.parsed.projection.nodes.every((item) =>
    !item.summary.includes('AUTHORITATIVE_VERDICT=') &&
    !item.summary.includes('AUTHORITATIVE_EVIDENCE_TOKEN=')
  ));

  const expandedArgs = [
    'project',
    '--memory-root', consumerMemory,
    '--project', 'anet-memory-oversized-benchmark',
    '--seed-artifact', runId + '-task',
    '--relation-type', 'depends_on',
    '--relation-type', 'evidence',
    '--max-nodes', '8',
    '--max-bytes', '8000',
    '--max-depth', '2',
  ];

  const expanded = await runNode(snapshot, expandedArgs);
  const repeated = await runNode(snapshot, expandedArgs);

  assert.equal(expanded.stdout, repeated.stdout);
  assert.equal(sha256(expanded.stdout), sha256(repeated.stdout));

  const projection = expanded.parsed.projection;
  assert.equal(projection.status, 'OK');
  assert.ok(projection.budget.used_nodes <= 8);
  assert.ok(projection.budget.used_bytes <= 8000);
  assert.deepEqual(projection.frontier, []);
  assert.deepEqual(projection.omitted.budget, []);
  assert.deepEqual(projection.omitted.unresolved, []);

  const ids = projection.nodes.map((item) => item.artifact_id);
  assert.deepEqual(ids, [
    runId + '-task',
    runId + '-d-current',
    runId + '-e-current',
  ]);
  assert.ok(ids.every((id) => !id.includes('-noise-')));

  const decision = projection.nodes.find((item) =>
    item.artifact_id === runId + '-d-current'
  );
  const evidence = projection.nodes.find((item) =>
    item.artifact_id === runId + '-e-current'
  );

  const derived = {
    verdict: extractValue(decision.summary, 'AUTHORITATIVE_VERDICT'),
    evidenceToken: extractValue(
      evidence.summary,
      'AUTHORITATIVE_EVIDENCE_TOKEN',
    ),
  };

  assert.deepEqual(derived, expectedAnswer);
  assert.equal(
    sha256(canonicalAnswerJson(derived)),
    meta.answer_commitment_sha256,
  );
});

test('prepare output never prints plaintext benchmark answer', async (t) => {
  const parent = await tempRoot('anet-oversized-no-leak-');
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await runNode(prepare, [
    '--memory-root', path.join(parent, 'memory'),
    '--run-id', 'oversized-no-leak',
    '--verdict', 'RELEASE',
    '--evidence-token', 'EV-super-secret-token',
    '--noise-count', '2',
    '--noise-bytes', '512',
  ]);

  assert.ok(!result.stdout.includes('RELEASE'));
  assert.ok(!result.stdout.includes('EV-super-secret-token'));
  assert.match(result.parsed.answer_commitment_sha256, /^[a-f0-9]{64}$/);
});
