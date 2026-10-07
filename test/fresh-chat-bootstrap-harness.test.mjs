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


test('fresh-chat harness distinguishes current state from bounded historical rationale', async (t) => {
  const publisher = await tempRoot('anet-history-publisher-');
  const consumer = await tempRoot('anet-history-consumer-');
  const bundle = await tempRoot('anet-history-bundle-');
  t.after(() => Promise.all([
    rm(publisher, { recursive: true, force: true }),
    rm(consumer, { recursive: true, force: true }),
    rm(bundle, { recursive: true, force: true }),
  ]));

  const artifacts = [
    createMemoryArtifact({
      artifactId: 'task-history',
      kind: 'task',
      project: 'anet-memory',
      subject: 'pollution resistance and rationale recovery',
      summary: 'verify current state excludes history while historical query recovers rationale',
      status: 'OPEN',
      context: 'history-test',
      relations: [
        { type: 'depends_on', target: 'decision-old' },
        { type: 'depends_on', target: 'alternative-rejected' },
      ],
      provenance: ['github:issue/46'],
    }),
    createMemoryArtifact({
      artifactId: 'decision-old',
      kind: 'decision',
      project: 'anet-memory',
      subject: 'retrieval policy',
      summary: 'old decision that should not survive as current',
      status: 'HISTORICAL',
      context: 'history-test',
      relations: [{ type: 'evidence', target: 'evidence-old' }],
      provenance: ['test:old-decision'],
    }),
    createMemoryArtifact({
      artifactId: 'decision-current',
      kind: 'decision',
      project: 'anet-memory',
      subject: 'retrieval policy',
      summary: 'current replacement decision',
      status: 'ACTIVE',
      context: 'history-test',
      relations: [{ type: 'evidence', target: 'evidence-current' }],
      provenance: ['test:current-decision'],
    }),
    createMemoryArtifact({
      artifactId: 'alternative-rejected',
      kind: 'claim',
      project: 'anet-memory',
      subject: 'retrieval policy alternative',
      summary: 'rejected alternative that must not pollute current state',
      status: 'HISTORICAL',
      context: 'history-test',
      relations: [{ type: 'rejected_by', target: 'decision-reject' }],
      provenance: ['test:rejected-alternative'],
    }),
    createMemoryArtifact({
      artifactId: 'decision-reject',
      kind: 'decision',
      project: 'anet-memory',
      subject: 'rejection rationale',
      summary: 'reject the alternative because it breaks current-state filtering',
      status: 'ACTIVE',
      context: 'history-test',
      relations: [{ type: 'evidence', target: 'evidence-reject' }],
      provenance: ['test:rejection-decision'],
    }),
    createMemoryArtifact({
      artifactId: 'evidence-old',
      kind: 'evidence',
      project: 'anet-memory',
      subject: 'old decision evidence',
      summary: 'historical evidence for the old decision',
      status: 'HISTORICAL',
      context: 'history-test',
      relations: [],
      provenance: ['test:evidence-old'],
    }),
    createMemoryArtifact({
      artifactId: 'evidence-current',
      kind: 'evidence',
      project: 'anet-memory',
      subject: 'current decision evidence',
      summary: 'evidence for the replacement decision',
      status: 'ACTIVE',
      context: 'history-test',
      relations: [],
      provenance: ['test:evidence-current'],
    }),
    createMemoryArtifact({
      artifactId: 'evidence-reject',
      kind: 'evidence',
      project: 'anet-memory',
      subject: 'rejection evidence',
      summary: 'evidence explaining why the alternative was rejected',
      status: 'ACTIVE',
      context: 'history-test',
      relations: [],
      provenance: ['test:evidence-reject'],
    }),
  ];

  for (const artifact of artifacts) {
    await appendMemoryArtifact(publisher, artifact);
  }

  const events = [
    createMemoryEvent({
      eventId: 'task-history-1',
      artifactId: 'task-history',
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'user',
      createdAt: '2026-10-08T00:00:00.000Z',
    }),
    createMemoryEvent({
      eventId: 'decision-old-1',
      artifactId: 'decision-old',
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'user',
      createdAt: '2026-10-08T00:00:01.000Z',
    }),
    createMemoryEvent({
      eventId: 'decision-old-2',
      artifactId: 'decision-old',
      sequence: 2,
      previousEventId: 'decision-old-1',
      action: 'supersede',
      authority: 'author',
      actor: 'user',
      replacementArtifactId: 'decision-current',
      createdAt: '2026-10-08T00:00:02.000Z',
    }),
    createMemoryEvent({
      eventId: 'decision-current-1',
      artifactId: 'decision-current',
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'user',
      createdAt: '2026-10-08T00:00:03.000Z',
    }),
    createMemoryEvent({
      eventId: 'alternative-rejected-1',
      artifactId: 'alternative-rejected',
      sequence: 1,
      action: 'reject',
      authority: 'author',
      actor: 'user',
      createdAt: '2026-10-08T00:00:04.000Z',
    }),
    createMemoryEvent({
      eventId: 'decision-reject-1',
      artifactId: 'decision-reject',
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'user',
      createdAt: '2026-10-08T00:00:05.000Z',
    }),
    ...['evidence-old', 'evidence-current', 'evidence-reject'].map((artifactId, index) =>
      createMemoryEvent({
        eventId: artifactId + '-1',
        artifactId,
        sequence: 1,
        action: 'observe',
        authority: 'external',
        actor: 'test',
        createdAt: '2026-10-08T00:00:0' + (6 + index) + '.000Z',
      })
    ),
  ];
  for (const event of events) await appendMemoryEvent(publisher, event);

  await runHarness([
    'export',
    '--memory-root', publisher,
    '--out', bundle,
    '--manifest-id', 'history-run-1',
    '--project', 'anet-memory',
    '--root-artifact', 'task-history',
    '--provenance', 'github:issue/46',
  ]);

  await runHarness([
    'import',
    '--memory-root', consumer,
    '--bundle-root', bundle,
    '--manifest', path.join(bundle, 'manifests', 'history-run-1.json'),
  ]);

  const current = await runHarness([
    'bootstrap',
    '--memory-root', consumer,
    '--project', 'anet-memory',
    '--task', 'pollution resistance and rationale recovery',
    '--root-artifact', 'task-history',
    '--max-nodes', '8',
    '--max-bytes', '100000',
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

  assert.ok(currentIds.includes('task-history'));
  assert.ok(currentIds.includes('decision-current'));
  assert.ok(currentIds.includes('evidence-current'));
  assert.ok(!currentIds.includes('decision-old'));
  assert.ok(!currentIds.includes('alternative-rejected'));
  assert.ok(current.bootstrap.redirects.some((item) =>
    item.from === 'decision-old' && item.to === 'decision-current'
  ));
  assert.ok(current.bootstrap.omitted.policy.some((item) =>
    item.artifact_id === 'alternative-rejected' &&
    item.reason === 'HISTORICAL_EXCLUDED'
  ));

  const superseded = await runHarness([
    'project',
    '--memory-root', consumer,
    '--project', 'anet-memory',
    '--seed-artifact', 'decision-old',
    '--relation-type', 'evidence',
    '--include-historical', 'true',
    '--max-nodes', '8',
    '--max-bytes', '100000',
    '--max-depth', '3',
  ]);

  assert.equal(superseded.command, 'project');
  assert.deepEqual(
    superseded.projection.nodes.map((item) => item.artifact_id),
    ['decision-old', 'evidence-old', 'decision-current', 'evidence-current'],
  );
  assert.equal(superseded.projection.nodes[0].lifecycle.lifecycle, 'SUPERSEDED');
  assert.equal(
    superseded.projection.nodes.find((item) => item.artifact_id === 'decision-current')
      .lifecycle.lifecycle,
    'ACCEPTED',
  );

  const rejected = await runHarness([
    'project',
    '--memory-root', consumer,
    '--project', 'anet-memory',
    '--seed-artifact', 'alternative-rejected',
    '--relation-type', 'rejected_by',
    '--relation-type', 'evidence',
    '--include-historical', 'true',
    '--max-nodes', '8',
    '--max-bytes', '100000',
    '--max-depth', '3',
  ]);

  assert.deepEqual(
    rejected.projection.nodes.map((item) => item.artifact_id),
    ['alternative-rejected', 'decision-reject', 'evidence-reject'],
  );
  assert.equal(rejected.projection.nodes[0].lifecycle.lifecycle, 'REJECTED');
  assert.ok(rejected.projection.nodes.every((item) =>
    item.semantic_provenance.length > 0
  ));
});
