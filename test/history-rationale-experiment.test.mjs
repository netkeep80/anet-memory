import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const prepare = path.resolve('experiments/history-rationale/prepare.mjs');
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
        reject(new Error('process exited ' + code + '\nstdout:\n' + out + '\nstderr:\n' + err));
        return;
      }
      resolve(JSON.parse(out));
    });
  });
}

test('history-rationale fixture passes current and historical acceptance assertions', async (t) => {
  const memoryRoot = path.join(await tempRoot('anet-history-fixture-parent-'), 'memory');
  t.after(() => rm(path.dirname(memoryRoot), { recursive: true, force: true }));

  const runId = 'history-rationale-test-1';
  const fixture = await runNode(prepare, [
    '--memory-root', memoryRoot,
    '--run-id', runId,
  ]);

  assert.equal(fixture.protocol, 'anet-memory/history-rationale-fixture/1');
  assert.equal(fixture.artifact_count, 8);
  assert.equal(fixture.event_count, 9);

  const current = await runNode(snapshot, [
    'bootstrap',
    '--memory-root', memoryRoot,
    '--project', 'anet-memory-history-test',
    '--task', 'fresh-chat pollution resistance and rationale recovery',
    '--root-artifact', runId + '-task',
    '--max-nodes', '8',
    '--max-bytes', '12000',
    '--max-depth', '3',
  ]);

  const currentIds = [
    ...current.bootstrap.working_set.decisions,
    ...current.bootstrap.working_set.tasks.open,
    ...current.bootstrap.working_set.tasks.blocked,
    ...current.bootstrap.working_set.tasks.other,
    ...current.bootstrap.working_set.evidence,
    ...current.bootstrap.working_set.claims,
    ...current.bootstrap.working_set.other,
  ].map((item) => item.artifact_id);

  assert.ok(currentIds.includes(runId + '-task'));
  assert.ok(currentIds.includes(runId + '-d2'));
  assert.ok(currentIds.includes(runId + '-e2'));
  assert.ok(!currentIds.includes(runId + '-d1'));
  assert.ok(!currentIds.includes(runId + '-r1'));
  assert.ok(current.bootstrap.redirects.some((item) =>
    item.from === runId + '-d1' && item.to === runId + '-d2'
  ));
  assert.ok(current.bootstrap.omitted.policy.some((item) =>
    item.artifact_id === runId + '-r1' && item.reason === 'HISTORICAL_EXCLUDED'
  ));
  assert.ok(current.bootstrap.budget.used_nodes <= 8);
  assert.ok(current.bootstrap.budget.used_bytes <= 12000);

  const superseded = await runNode(snapshot, [
    'project',
    '--memory-root', memoryRoot,
    '--project', 'anet-memory-history-test',
    '--seed-artifact', runId + '-d1',
    '--relation-type', 'evidence',
    '--include-historical', 'true',
    '--max-nodes', '8',
    '--max-bytes', '12000',
    '--max-depth', '3',
  ]);

  assert.deepEqual(
    superseded.projection.nodes.map((item) => item.artifact_id),
    [runId + '-d1', runId + '-e1', runId + '-d2', runId + '-e2'],
  );
  assert.equal(superseded.projection.nodes[0].lifecycle.lifecycle, 'SUPERSEDED');
  assert.ok(superseded.projection.nodes.every((item) =>
    item.semantic_provenance.length > 0
  ));

  const rejected = await runNode(snapshot, [
    'project',
    '--memory-root', memoryRoot,
    '--project', 'anet-memory-history-test',
    '--seed-artifact', runId + '-r1',
    '--relation-type', 'rejected_by',
    '--relation-type', 'evidence',
    '--include-historical', 'true',
    '--max-nodes', '8',
    '--max-bytes', '12000',
    '--max-depth', '3',
  ]);

  assert.deepEqual(
    rejected.projection.nodes.map((item) => item.artifact_id),
    [runId + '-r1', runId + '-dr', runId + '-er'],
  );
  assert.equal(rejected.projection.nodes[0].lifecycle.lifecycle, 'REJECTED');
  assert.ok(rejected.projection.nodes.every((item) =>
    item.semantic_provenance.length > 0
  ));
});

test('history-rationale fixture refuses to write into a non-empty root', async (t) => {
  const root = await tempRoot('anet-history-nonempty-');
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prepare,
      '--memory-root', root,
      '--run-id', 'history-rationale-test-2',
    ], {
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });

  // A mkdtemp root is empty, so the first preparation is valid.
  assert.equal(result.code, 0, result.stderr);

  const second = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prepare,
      '--memory-root', root,
      '--run-id', 'history-rationale-test-3',
    ], {
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });

  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /memory root must be empty or missing/);
});
