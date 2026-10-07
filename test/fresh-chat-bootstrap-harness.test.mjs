import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { appendMemoryArtifact, createMemoryArtifact } from '../src/memory-artifacts.mjs';
import { appendMemoryEvent, createMemoryEvent } from '../src/memory-events.mjs';

const harness = path.resolve('experiments/fresh-chat-bootstrap/snapshot.mjs');

async function tempRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function runHarness(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harness, ...args], {
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
        reject(new Error('harness exited ' + code + '\nstdout:\n' + out + '\nstderr:\n' + err));
        return;
      }
      resolve(JSON.parse(out));
    });
  });
}

test('fresh-chat harness exports exact bundle, imports it, and bootstraps a new local root', async (t) => {
  const publisher = await tempRoot('anet-fresh-publisher-');
  const consumer = await tempRoot('anet-fresh-consumer-');
  const bundle = await tempRoot('anet-fresh-bundle-');
  t.after(() => Promise.all([
    rm(publisher, { recursive: true, force: true }),
    rm(consumer, { recursive: true, force: true }),
    rm(bundle, { recursive: true, force: true }),
  ]));

  const task = createMemoryArtifact({
    artifactId: 'task-harness',
    kind: 'task',
    project: 'anet-memory',
    subject: 'real fresh chat bootstrap',
    summary: 'resume development from persistent memory',
    status: 'OPEN',
    context: 'test',
    relations: [{ type: 'depends_on', target: 'decision-harness' }],
    provenance: ['github:issue/40'],
  });
  const decision = createMemoryArtifact({
    artifactId: 'decision-harness',
    kind: 'decision',
    project: 'anet-memory',
    subject: 'persistent memory',
    summary: 'Library snapshot is the cross-chat durable carrier',
    status: 'ACTIVE',
    context: 'test',
    relations: [{ type: 'evidence', target: 'evidence-harness' }],
    provenance: ['github:issue/38'],
  });
  const evidence = createMemoryArtifact({
    artifactId: 'evidence-harness',
    kind: 'evidence',
    project: 'anet-memory',
    subject: 'harness evidence',
    summary: 'export and import verified exact bytes',
    status: 'ACTIVE',
    context: 'test',
    relations: [],
    provenance: ['test:harness'],
  });

  for (const artifact of [task, decision, evidence]) {
    await appendMemoryArtifact(publisher, artifact);
  }

  const events = [
    createMemoryEvent({
      eventId: 'task-harness-1',
      artifactId: task.artifact_id,
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'user',
      createdAt: '2026-10-07T23:20:00.000Z',
    }),
    createMemoryEvent({
      eventId: 'decision-harness-1',
      artifactId: decision.artifact_id,
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'user',
      createdAt: '2026-10-07T23:20:01.000Z',
    }),
    createMemoryEvent({
      eventId: 'evidence-harness-1',
      artifactId: evidence.artifact_id,
      sequence: 1,
      action: 'observe',
      authority: 'external',
      actor: 'test',
      createdAt: '2026-10-07T23:20:02.000Z',
    }),
  ];
  for (const event of events) await appendMemoryEvent(publisher, event);

  const exported = await runHarness([
    'export',
    '--memory-root', publisher,
    '--out', bundle,
    '--manifest-id', 'harness-run-1',
    '--project', 'anet-memory',
    '--root-artifact', task.artifact_id,
    '--provenance', 'github:issue/40',
  ]);

  assert.equal(exported.command, 'export');
  assert.equal(exported.objects.length, 6);
  assert.equal(exported.publish_last.library_path, '/anet-memory/v1/manifests/harness-run-1.json');

  const imported = await runHarness([
    'import',
    '--memory-root', consumer,
    '--bundle-root', bundle,
    '--manifest', path.join(bundle, 'manifests', 'harness-run-1.json'),
  ]);

  assert.equal(imported.command, 'import');
  assert.equal(imported.imported.length, 6);
  assert.deepEqual(imported.root_artifact_ids, ['task-harness']);
  assert.deepEqual(imported.missing_semantic_records, []);
  assert.deepEqual(imported.dangling_relations, []);

  const bootstrap = await runHarness([
    'bootstrap',
    '--memory-root', consumer,
    '--project', 'anet-memory',
    '--task', 'real fresh chat bootstrap',
    '--root-artifact', 'task-harness',
    '--max-nodes', '3',
    '--max-bytes', '100000',
    '--max-depth', '3',
  ]);

  assert.equal(bootstrap.command, 'bootstrap');
  assert.deepEqual(
    bootstrap.bootstrap.working_set.tasks.open.map((item) => item.artifact_id),
    ['task-harness'],
  );
  assert.deepEqual(
    bootstrap.bootstrap.working_set.decisions.map((item) => item.artifact_id),
    ['decision-harness'],
  );
  assert.deepEqual(
    bootstrap.bootstrap.working_set.evidence.map((item) => item.artifact_id),
    ['evidence-harness'],
  );
});
