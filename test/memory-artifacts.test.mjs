import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MemoryArtifactError,
  appendMemoryArtifact,
  buildMemoryGraph,
  createMemoryArtifact,
  rebuildArtifactCatalog,
  validateMemoryArtifact,
} from '../src/memory-artifacts.mjs';
import {
  appendMemoryEvent,
  createMemoryEvent,
  rebuildMemoryState,
} from '../src/memory-events.mjs';

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'anet-memory-artifacts-'));
}

function artifact(artifactId, overrides = {}) {
  return createMemoryArtifact({
    artifactId,
    kind: 'decision',
    project: 'anet-memory',
    subject: artifactId,
    summary: 'summary for ' + artifactId,
    status: null,
    context: 'v1',
    relations: [],
    provenance: ['test:' + artifactId],
    ...overrides,
  });
}

async function event(root, {
  eventId,
  artifactId,
  sequence = 1,
  previousEventId = null,
  action,
  authority,
  actor = 'test',
  replacementArtifactId,
  provenance = [],
}) {
  return appendMemoryEvent(root, createMemoryEvent({
    eventId,
    artifactId,
    sequence,
    previousEventId,
    action,
    authority,
    actor,
    replacementArtifactId,
    provenance,
    createdAt: '2026-10-07T20:45:00.000Z',
  }));
}

test('semantic artifact shape is strict and transport metadata cannot leak into semantics', () => {
  const value = artifact('decision-a', {
    relations: [{ type: 'depends_on', target: 'decision-b' }],
  });

  assert.equal(validateMemoryArtifact(value), value);

  assert.throws(
    () => validateMemoryArtifact({ ...value, transport_meta: { sandbox: 'x' } }),
    (error) => error instanceof MemoryArtifactError && error.code === 'UNEXPECTED_FIELD',
  );

  assert.throws(
    () => artifact('decision-a', {
      relations: [
        { type: 'depends_on', target: 'decision-b' },
        { type: 'depends_on', target: 'decision-b' },
      ],
    }),
    (error) => error instanceof MemoryArtifactError && error.code === 'DUPLICATE_RELATION',
  );
});

test('semantic artifacts are immutable and duplicate-safe by artifact_id', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const value = artifact('immutable-a');
  const first = await appendMemoryArtifact(root, value);
  const second = await appendMemoryArtifact(root, structuredClone(value));

  assert.equal(first.status, 'appended');
  assert.equal(second.status, 'duplicate');

  await assert.rejects(
    () => appendMemoryArtifact(root, { ...value, summary: 'different meaning' }),
    (error) => error instanceof MemoryArtifactError && error.code === 'ARTIFACT_ID_CONFLICT',
  );
});

test('artifact catalog rebuild is deterministic, digest-backed and reports invalid files', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await appendMemoryArtifact(root, artifact('a'));
  await appendMemoryArtifact(root, artifact('b'));

  const first = await rebuildArtifactCatalog(root, {
    now: () => '2026-10-07T20:45:01.000Z',
  });
  const second = await rebuildArtifactCatalog(root, {
    now: () => '2026-10-07T20:45:02.000Z',
  });

  assert.equal(first.source.source_sha256, second.source.source_sha256);
  assert.deepEqual(first.artifacts, second.artifacts);
  assert.notEqual(first.generated_at, second.generated_at);

  const invalidDir = path.join(root, 'artifacts');
  await mkdir(invalidDir, { recursive: true });
  await writeFile(path.join(invalidDir, 'broken.json'), '{not-json', 'utf8');

  const withInvalid = await rebuildArtifactCatalog(root);
  assert.equal(withInvalid.source.invalid_artifacts, 1);
  assert.deepEqual(Object.keys(withInvalid.artifacts), ['a', 'b']);
  assert.notEqual(withInvalid.source.source_sha256, first.source.source_sha256);
});

test('catalog fails closed when multiple files claim one artifact_id with conflicting content', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const original = artifact('conflict-a');
  await appendMemoryArtifact(root, original);

  const dir = path.join(root, 'artifacts');
  await writeFile(
    path.join(dir, 'z-a-duplicate.json'),
    JSON.stringify(original, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    path.join(dir, 'z-b-conflict.json'),
    JSON.stringify({ ...original, summary: 'conflicting semantic content' }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    path.join(dir, 'z-c-after-conflict.json'),
    JSON.stringify(original, null, 2) + '\n',
    'utf8',
  );

  const catalog = await rebuildArtifactCatalog(root);

  assert.equal(catalog.source.duplicate_artifacts, 1);
  assert.equal(catalog.source.conflicting_artifacts, 2);
  assert.equal(catalog.artifacts['conflict-a'], undefined);
  assert.ok(catalog.source.conflicts.every((item) => item.artifact_id === 'conflict-a'));
});


test('relation-bearing graph joins semantic records with independent lifecycle authority', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const records = [
    artifact('decision-old', {
      subject: 'projection approach',
      summary: 'old decision',
    }),
    artifact('decision-new', {
      subject: 'projection approach',
      summary: 'current decision',
      relations: [{ type: 'evidence', target: 'evidence-1' }],
    }),
    artifact('hypothesis-x', {
      kind: 'hypothesis',
      subject: 'vector-only retrieval',
      summary: 'rejected hypothesis',
    }),
    artifact('task-open', {
      kind: 'task',
      subject: 'implement deterministic projection',
      summary: 'open implementation task',
      status: 'OPEN',
      relations: [{ type: 'depends_on', target: 'decision-new' }],
    }),
    artifact('task-blocked', {
      kind: 'task',
      subject: 'fresh-chat bootstrap',
      summary: 'blocked until projection exists',
      status: 'BLOCKED',
      relations: [
        { type: 'depends_on', target: 'task-open' },
        { type: 'depends_on', target: 'missing-target' },
      ],
    }),
    artifact('evidence-1', {
      kind: 'evidence',
      subject: 'audit evidence',
      summary: 'repository evidence',
      status: 'ACTIVE',
    }),
    artifact('claim-1', {
      kind: 'claim',
      subject: 'projection is relation-native',
      summary: 'claim with explicit evidence',
      relations: [{ type: 'evidence', target: 'evidence-1' }],
    }),
    artifact('semantic-only', {
      kind: 'evidence',
      subject: 'not yet lifecycle tracked',
      summary: 'semantic record without lifecycle event',
    }),
  ];

  for (const value of records) await appendMemoryArtifact(root, value);

  await event(root, {
    eventId: 'old-1',
    artifactId: 'decision-old',
    action: 'accept',
    authority: 'author',
  });
  await event(root, {
    eventId: 'old-2',
    artifactId: 'decision-old',
    sequence: 2,
    previousEventId: 'old-1',
    action: 'supersede',
    authority: 'author',
    replacementArtifactId: 'decision-new',
  });
  await event(root, {
    eventId: 'new-1',
    artifactId: 'decision-new',
    action: 'accept',
    authority: 'author',
  });
  await event(root, {
    eventId: 'hyp-1',
    artifactId: 'hypothesis-x',
    action: 'reject',
    authority: 'author',
  });
  await event(root, {
    eventId: 'task-open-1',
    artifactId: 'task-open',
    action: 'accept',
    authority: 'author',
  });
  await event(root, {
    eventId: 'task-blocked-1',
    artifactId: 'task-blocked',
    action: 'accept',
    authority: 'author',
  });
  await event(root, {
    eventId: 'evidence-1-event',
    artifactId: 'evidence-1',
    action: 'observe',
    authority: 'external',
    provenance: ['github:commit/example'],
  });
  await event(root, {
    eventId: 'claim-1-event',
    artifactId: 'claim-1',
    action: 'accept',
    authority: 'author',
  });
  await event(root, {
    eventId: 'event-only-1',
    artifactId: 'event-only',
    action: 'accept',
    authority: 'author',
  });

  const memoryState = await rebuildMemoryState(root, {
    now: () => '2026-10-07T20:46:00.000Z',
  });
  const catalog = await rebuildArtifactCatalog(root, {
    now: () => '2026-10-07T20:46:00.000Z',
  });
  const graph = buildMemoryGraph(memoryState, catalog, {
    generatedAt: '2026-10-07T20:46:00.000Z',
  });

  assert.deepEqual(graph.classifications.accepted, [
    'claim-1',
    'decision-new',
    'event-only',
    'task-blocked',
    'task-open',
  ]);
  assert.deepEqual(graph.classifications.candidates, ['evidence-1']);
  assert.deepEqual(graph.classifications.rejected, ['hypothesis-x']);
  assert.deepEqual(graph.classifications.superseded, ['decision-old']);

  assert.equal(graph.nodes['task-open'].status, 'OPEN');
  assert.deepEqual(graph.nodes['task-open'].relations, [
    { type: 'depends_on', target: 'decision-new' },
  ]);
  assert.deepEqual(graph.nodes['claim-1'].relations, [
    { type: 'evidence', target: 'evidence-1' },
  ]);
  assert.equal(graph.nodes['decision-old'].lifecycle.replacement_artifact_id, 'decision-new');

  assert.deepEqual(graph.missing_semantic_records, ['event-only']);
  assert.deepEqual(graph.semantic_without_lifecycle, ['semantic-only']);
  assert.deepEqual(graph.dangling_relations, [
    { source: 'task-blocked', type: 'depends_on', target: 'missing-target' },
  ]);

  assert.equal(
    graph.source.memory_event_source_sha256,
    memoryState.journal.source_sha256,
  );
  assert.equal(
    graph.source.semantic_artifact_source_sha256,
    catalog.source.source_sha256,
  );
});

test('catalog source remains rebuildable from exact durable artifact files', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const value = artifact('roundtrip-a');
  await appendMemoryArtifact(root, value);

  const first = await rebuildArtifactCatalog(root);
  const text = await readFile(path.join(root, 'artifacts', 'roundtrip-a.json'), 'utf8');
  assert.equal(JSON.parse(text).artifact_id, 'roundtrip-a');

  const second = await rebuildArtifactCatalog(root);
  assert.equal(first.source.source_sha256, second.source.source_sha256);
  assert.deepEqual(first.artifacts, second.artifacts);
});
