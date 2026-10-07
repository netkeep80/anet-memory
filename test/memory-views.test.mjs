import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendMemoryEvent,
  createMemoryEvent,
  rebuildMemoryState,
} from '../src/memory-events.mjs';
import {
  buildMemoryViews,
  isMemoryViewFresh,
  rebuildMemoryViews,
} from '../src/memory-views.mjs';

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'anet-memory-views-'));
}

function event({
  eventId,
  artifactId,
  sequence,
  previousEventId = null,
  action,
  authority,
  actor,
  provenance = [],
  replacementArtifactId,
} = {}) {
  return createMemoryEvent({
    eventId,
    artifactId,
    sequence,
    previousEventId,
    action,
    authority,
    actor,
    provenance,
    replacementArtifactId,
    createdAt: `2026-10-07T22:${String(sequence).padStart(2, '0')}:00.000Z`,
  });
}

test('current view excludes rejected and superseded artifacts', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const events = [
    event({ eventId: 'a1', artifactId: 'accepted-a', sequence: 1, action: 'propose', authority: 'model', actor: 'chat' }),
    event({ eventId: 'a2', artifactId: 'accepted-a', sequence: 2, previousEventId: 'a1', action: 'accept', authority: 'author', actor: 'user', provenance: ['chat:approval'] }),

    event({ eventId: 'p1', artifactId: 'proposed-b', sequence: 1, action: 'propose', authority: 'model', actor: 'chat' }),

    event({ eventId: 'r1', artifactId: 'rejected-c', sequence: 1, action: 'propose', authority: 'model', actor: 'chat' }),
    event({ eventId: 'r2', artifactId: 'rejected-c', sequence: 2, previousEventId: 'r1', action: 'reject', authority: 'author', actor: 'user' }),

    event({ eventId: 's1', artifactId: 'superseded-d', sequence: 1, action: 'propose', authority: 'model', actor: 'chat' }),
    event({ eventId: 's2', artifactId: 'superseded-d', sequence: 2, previousEventId: 's1', action: 'accept', authority: 'author', actor: 'user' }),
    event({ eventId: 's3', artifactId: 'superseded-d', sequence: 3, previousEventId: 's2', action: 'supersede', authority: 'author', actor: 'user', replacementArtifactId: 'accepted-a' }),
  ];

  for (const item of events) await appendMemoryEvent(root, item);

  const state = await rebuildMemoryState(root, { now: () => 'state' });
  const view = buildMemoryViews(state, { generatedAt: 'view' });

  assert.deepEqual(view.current.accepted.map((item) => item.artifact_id), ['accepted-a']);
  assert.deepEqual(view.current.candidates.map((item) => item.artifact_id), ['proposed-b']);
  assert.deepEqual(view.historical.rejected.map((item) => item.artifact_id), ['rejected-c']);
  assert.deepEqual(view.historical.superseded.map((item) => item.artifact_id), ['superseded-d']);

  assert.deepEqual(
    view.current.accepted[0].provenance,
    [{ event_id: 'a2', action: 'accept', refs: ['chat:approval'] }],
  );
});

test('authority errors are isolated into attention view', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await appendMemoryEvent(root, event({
    eventId: 'e1',
    artifactId: 'unsafe-a',
    sequence: 1,
    action: 'propose',
    authority: 'model',
    actor: 'chat',
  }));
  await appendMemoryEvent(root, event({
    eventId: 'e2',
    artifactId: 'unsafe-a',
    sequence: 2,
    previousEventId: 'e1',
    action: 'accept',
    authority: 'model',
    actor: 'chat',
  }));

  const state = await rebuildMemoryState(root);
  const view = buildMemoryViews(state);

  assert.equal(view.current.accepted.length, 0);
  assert.equal(view.attention.length, 1);
  assert.equal(view.attention[0].artifact_id, 'unsafe-a');
  assert.equal(view.attention[0].state, 'AUTHORITY_ERROR');
});

test('materialized view exposes source digest and detects staleness', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await appendMemoryEvent(root, event({
    eventId: 'e1',
    artifactId: 'artifact-a',
    sequence: 1,
    action: 'propose',
    authority: 'model',
    actor: 'chat',
  }));

  const initialState = await rebuildMemoryState(root, { now: () => 'state-1' });
  const initialView = await rebuildMemoryViews(root, { now: () => 'view-1' });
  assert.ok(isMemoryViewFresh(initialView, initialState));

  await appendMemoryEvent(root, event({
    eventId: 'e2',
    artifactId: 'artifact-a',
    sequence: 2,
    previousEventId: 'e1',
    action: 'accept',
    authority: 'author',
    actor: 'user',
  }));

  const updatedState = await rebuildMemoryState(root, { now: () => 'state-2' });
  assert.notEqual(
    updatedState.journal.source_sha256,
    initialState.journal.source_sha256,
  );
  assert.equal(isMemoryViewFresh(initialView, updatedState), false);

  const updatedView = await rebuildMemoryViews(root, { now: () => 'view-2' });
  assert.ok(isMemoryViewFresh(updatedView, updatedState));
  assert.deepEqual(updatedView.current.accepted.map((item) => item.artifact_id), ['artifact-a']);

  const saved = JSON.parse(await readFile(path.join(root, 'views', 'memory-current.json'), 'utf8'));
  assert.equal(saved.source.journal_source_sha256, updatedState.journal.source_sha256);
});

test('journal digest and semantic view rebuild identically after restart', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await appendMemoryEvent(root, event({
    eventId: 'e1',
    artifactId: 'artifact-a',
    sequence: 1,
    action: 'observe',
    authority: 'system',
    actor: 'tool',
    provenance: ['github:issue/1'],
  }));

  const firstState = await rebuildMemoryState(root, { now: () => 'first-state' });
  const firstView = await rebuildMemoryViews(root, { now: () => 'first-view' });

  const secondState = await rebuildMemoryState(root, { now: () => 'second-state' });
  const secondView = await rebuildMemoryViews(root, { now: () => 'second-view' });

  assert.equal(firstState.journal.source_sha256, secondState.journal.source_sha256);
  assert.deepEqual(firstState.artifacts, secondState.artifacts);
  assert.deepEqual(firstView.current, secondView.current);
  assert.deepEqual(firstView.historical, secondView.historical);
  assert.deepEqual(firstView.attention, secondView.attention);
});
