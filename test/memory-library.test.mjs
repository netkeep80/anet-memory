import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createMemoryArtifact,
  buildMemoryGraph,
  rebuildArtifactCatalog,
  serializeMemoryArtifact,
} from '../src/memory-artifacts.mjs';
import {
  createMemoryEvent,
  rebuildMemoryState,
  serializeMemoryEvent,
} from '../src/memory-events.mjs';
import { bootstrapMemoryGraph } from '../src/memory-bootstrap.mjs';
import {
  MemoryLibraryError,
  createMemoryLibraryManifest,
  describeMemoryLibraryObject,
  importMemoryLibrarySnapshot,
  memoryLibraryArtifactPath,
  memoryLibraryEventPath,
  memoryLibraryManifestPath,
  serializeMemoryLibraryManifest,
  verifyMemoryLibraryObject,
} from '../src/memory-library.mjs';

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'anet-memory-library-'));
}

function fixture() {
  const task = createMemoryArtifact({
    artifactId: 'task-library-bootstrap',
    kind: 'task',
    project: 'anet-memory',
    subject: 'fresh chat library bootstrap',
    summary: 'resume development from persistent ANet objects',
    status: 'OPEN',
    context: 'phase-5',
    relations: [{ type: 'depends_on', target: 'decision-library' }],
    provenance: ['github:issue/38'],
  });
  const decision = createMemoryArtifact({
    artifactId: 'decision-library',
    kind: 'decision',
    project: 'anet-memory',
    subject: 'persistent memory snapshot',
    summary: 'use exact immutable Library objects plus manifest',
    status: 'ACTIVE',
    context: 'phase-5',
    relations: [{ type: 'evidence', target: 'evidence-library' }],
    provenance: ['github:issue/38'],
  });
  const evidence = createMemoryArtifact({
    artifactId: 'evidence-library',
    kind: 'evidence',
    project: 'anet-memory',
    subject: 'snapshot evidence',
    summary: 'exact bytes and hashes are verified before import',
    status: 'ACTIVE',
    context: 'phase-5',
    relations: [],
    provenance: ['test:library-snapshot'],
  });

  const events = [
    createMemoryEvent({
      eventId: 'task-library-bootstrap-1',
      artifactId: task.artifact_id,
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'user',
      provenance: ['chat:accepted-task'],
      createdAt: '2026-10-07T23:10:00.000Z',
    }),
    createMemoryEvent({
      eventId: 'decision-library-1',
      artifactId: decision.artifact_id,
      sequence: 1,
      action: 'accept',
      authority: 'author',
      actor: 'user',
      provenance: ['chat:accepted-decision'],
      createdAt: '2026-10-07T23:10:01.000Z',
    }),
    createMemoryEvent({
      eventId: 'evidence-library-1',
      artifactId: evidence.artifact_id,
      sequence: 1,
      action: 'observe',
      authority: 'external',
      actor: 'test',
      provenance: ['test:passed'],
      createdAt: '2026-10-07T23:10:02.000Z',
    }),
  ];

  const objectBytes = new Map();
  const descriptors = [];

  for (const artifact of [task, decision, evidence]) {
    const bytes = serializeMemoryArtifact(artifact);
    const descriptor = describeMemoryLibraryObject('artifact', bytes);
    descriptors.push(descriptor);
    objectBytes.set(descriptor.path, bytes);
  }
  for (const event of events) {
    const bytes = serializeMemoryEvent(event);
    const descriptor = describeMemoryLibraryObject('event', bytes);
    descriptors.push(descriptor);
    objectBytes.set(descriptor.path, bytes);
  }

  const manifest = createMemoryLibraryManifest({
    manifestId: 'fresh-chat-acceptance-001',
    project: 'anet-memory',
    createdAt: '2026-10-07T23:11:00.000Z',
    rootArtifactIds: [task.artifact_id],
    objects: descriptors,
    provenance: ['github:issue/38', 'github:main/test'],
  });

  return { task, decision, evidence, events, objectBytes, descriptors, manifest };
}

test('Library object descriptors derive physical path and hash from validated exact bytes', () => {
  const { task, events } = fixture();

  const artifactBytes = serializeMemoryArtifact(task);
  const artifactDescriptor = describeMemoryLibraryObject('artifact', artifactBytes);
  assert.equal(artifactDescriptor.logical_id, task.artifact_id);
  assert.equal(
    artifactDescriptor.path,
    memoryLibraryArtifactPath(task.artifact_id),
  );
  assert.equal(artifactDescriptor.sha256.length, 64);

  const eventBytes = serializeMemoryEvent(events[0]);
  const eventDescriptor = describeMemoryLibraryObject('event', eventBytes);
  assert.equal(eventDescriptor.logical_id, events[0].event_id);
  assert.equal(
    eventDescriptor.path,
    memoryLibraryEventPath(events[0].event_id),
  );
  assert.equal(memoryLibraryManifestPath('snapshot-1'), '/anet-memory/v1/manifests/snapshot-1.json');

  const reformatted = JSON.stringify(task) + '\n';
  assert.notEqual(
    describeMemoryLibraryObject('artifact', reformatted).sha256,
    artifactDescriptor.sha256,
  );
});

test('manifest is deterministic, strict and requires described roots', () => {
  const { manifest, descriptors } = fixture();
  const serialized = serializeMemoryLibraryManifest(manifest);
  assert.ok(serialized.includes('"protocol": "anet-memory/library-manifest/1"'));
  assert.deepEqual(
    manifest.objects.map((object) => object.path),
    [...manifest.objects].map((object) => object.path).sort(),
  );

  assert.throws(
    () => createMemoryLibraryManifest({
      manifestId: 'bad-root',
      project: 'anet-memory',
      rootArtifactIds: ['not-described'],
      objects: descriptors,
    }),
    (error) => error instanceof MemoryLibraryError && error.code === 'MISSING_ROOT_ARTIFACT',
  );

  const wrongPath = structuredClone(manifest);
  wrongPath.objects[0].path = '/anet-memory/v1/artifacts/not-the-id.json';
  assert.throws(
    () => serializeMemoryLibraryManifest(wrongPath),
    (error) => error instanceof MemoryLibraryError && error.code === 'OBJECT_PATH_MISMATCH',
  );
});

test('exact object verification fails on tamper and logical-ID substitution', () => {
  const { task } = fixture();
  const bytes = serializeMemoryArtifact(task);
  const descriptor = describeMemoryLibraryObject('artifact', bytes);

  assert.equal(
    verifyMemoryLibraryObject(descriptor, bytes).artifact_id,
    task.artifact_id,
  );

  assert.throws(
    () => verifyMemoryLibraryObject(descriptor, bytes + ' '),
    (error) => error instanceof MemoryLibraryError && error.code === 'OBJECT_HASH_MISMATCH',
  );

  const substituted = serializeMemoryArtifact({
    ...task,
    artifact_id: 'different-id',
  });
  const substitutedDescriptor = {
    ...descriptor,
    sha256: describeMemoryLibraryObject('artifact', substituted).sha256,
  };
  assert.throws(
    () => verifyMemoryLibraryObject(substitutedDescriptor, substituted),
    (error) => error instanceof MemoryLibraryError &&
      error.code === 'OBJECT_LOGICAL_ID_MISMATCH',
  );
});

test('snapshot import validates all objects before any local write', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { manifest, objectBytes } = fixture();
  const missing = new Map(objectBytes);
  missing.delete(manifest.objects[0].path);

  await assert.rejects(
    () => importMemoryLibrarySnapshot(root, manifest, missing),
    (error) => error instanceof MemoryLibraryError && error.code === 'MISSING_LIBRARY_OBJECT',
  );

  await assert.rejects(
    () => readdir(path.join(root, 'artifacts')),
    (error) => error?.code === 'ENOENT',
  );
  await assert.rejects(
    () => readdir(path.join(root, 'events')),
    (error) => error?.code === 'ENOENT',
  );
});

test('imported Library snapshot rebuilds the same graph and fresh-chat bootstrap semantics', async (t) => {
  const publisherRoot = await tempRoot();
  const consumerRoot = await tempRoot();
  t.after(() => Promise.all([
    rm(publisherRoot, { recursive: true, force: true }),
    rm(consumerRoot, { recursive: true, force: true }),
  ]));

  const { task, decision, evidence, events, manifest, objectBytes } = fixture();

  const publisherArtifacts = [task, decision, evidence];
  const {
    appendMemoryArtifact,
  } = await import('../src/memory-artifacts.mjs');
  const {
    appendMemoryEvent,
  } = await import('../src/memory-events.mjs');

  for (const artifact of publisherArtifacts) {
    await appendMemoryArtifact(publisherRoot, artifact);
  }
  for (const event of events) {
    await appendMemoryEvent(publisherRoot, event);
  }

  const publisherState = await rebuildMemoryState(publisherRoot, {
    now: () => 'publisher',
  });
  const publisherCatalog = await rebuildArtifactCatalog(publisherRoot, {
    now: () => 'publisher',
  });
  const publisherGraph = buildMemoryGraph(publisherState, publisherCatalog, {
    generatedAt: 'publisher',
  });
  const publisherBootstrap = bootstrapMemoryGraph(
    publisherGraph,
    {
      project: 'anet-memory',
      task: 'fresh chat library bootstrap',
      seed_ids: manifest.root_artifact_ids,
    },
    {
      max_nodes: 3,
      max_bytes: 100_000,
    },
  );

  const imported = await importMemoryLibrarySnapshot(
    consumerRoot,
    manifest,
    objectBytes,
  );

  const consumerBootstrap = bootstrapMemoryGraph(
    imported.memory_graph,
    {
      project: 'anet-memory',
      task: 'fresh chat library bootstrap',
      seed_ids: manifest.root_artifact_ids,
    },
    {
      max_nodes: 3,
      max_bytes: 100_000,
    },
  );

  assert.deepEqual(
    consumerBootstrap.working_set,
    publisherBootstrap.working_set,
  );
  assert.deepEqual(
    consumerBootstrap.seeds,
    publisherBootstrap.seeds,
  );
  assert.deepEqual(
    consumerBootstrap.frontier,
    publisherBootstrap.frontier,
  );
  assert.deepEqual(
    consumerBootstrap.working_set.tasks.open.map((item) => item.artifact_id),
    ['task-library-bootstrap'],
  );
  assert.deepEqual(
    consumerBootstrap.working_set.decisions.map((item) => item.artifact_id),
    ['decision-library'],
  );
  assert.deepEqual(
    consumerBootstrap.working_set.evidence.map((item) => item.artifact_id),
    ['evidence-library'],
  );
});

test('event outside manifest artifact set fails before import', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { manifest, objectBytes, events } = fixture();
  const foreignEvent = createMemoryEvent({
    eventId: 'foreign-event-1',
    artifactId: 'foreign-artifact',
    sequence: 1,
    action: 'observe',
    authority: 'external',
    actor: 'test',
    createdAt: '2026-10-07T23:12:00.000Z',
  });
  const bytes = serializeMemoryEvent(foreignEvent);
  const descriptor = describeMemoryLibraryObject('event', bytes);
  const badManifest = createMemoryLibraryManifest({
    manifestId: 'foreign-event-snapshot',
    project: manifest.project,
    rootArtifactIds: manifest.root_artifact_ids,
    objects: [...manifest.objects, descriptor],
    provenance: [],
  });
  const badObjects = new Map(objectBytes);
  badObjects.set(descriptor.path, bytes);

  await assert.rejects(
    () => importMemoryLibrarySnapshot(root, badManifest, badObjects),
    (error) => error instanceof MemoryLibraryError && error.code === 'EVENT_ARTIFACT_MISSING',
  );
});
