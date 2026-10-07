import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MemoryEventError,
  appendMemoryEvent,
  createMemoryEvent,
  evaluateArtifactHistory,
  rebuildMemoryState,
} from '../src/memory-events.mjs';

function event({
  eventId,
  artifactId = 'artifact-a',
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
    createdAt: `2026-10-07T21:${String(sequence).padStart(2, '0')}:00.000Z`,
  });
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'anet-memory-events-'));
}

test('model proposal plus explicit author acceptance becomes ACCEPTED', () => {
  const proposed = event({
    eventId: 'event-1',
    sequence: 1,
    action: 'propose',
    authority: 'model',
    actor: 'chat-a',
    provenance: ['chat:proposal'],
  });
  const accepted = event({
    eventId: 'event-2',
    sequence: 2,
    previousEventId: 'event-1',
    action: 'accept',
    authority: 'author',
    actor: 'user',
    provenance: ['chat:explicit-approval'],
  });

  const state = evaluateArtifactHistory('artifact-a', [accepted, proposed]);
  assert.equal(state.state, 'OK');
  assert.equal(state.lifecycle, 'ACCEPTED');
  assert.equal(state.accepted_by, 'user');
  assert.equal(state.next_sequence, 3);
});

test('model cannot promote its own proposal to accepted authority', () => {
  const proposed = event({
    eventId: 'event-1',
    sequence: 1,
    action: 'propose',
    authority: 'model',
    actor: 'chat-a',
  });
  const invalidAccept = event({
    eventId: 'event-2',
    sequence: 2,
    previousEventId: 'event-1',
    action: 'accept',
    authority: 'model',
    actor: 'chat-a',
  });

  const state = evaluateArtifactHistory('artifact-a', [proposed, invalidAccept]);
  assert.equal(state.state, 'AUTHORITY_ERROR');
  assert.equal(state.lifecycle, 'PROPOSED');
  assert.deepEqual(state.authority_errors, [{
    event_id: 'event-2',
    code: 'ACCEPT_REQUIRES_AUTHOR',
  }]);
});

test('external verification does not silently mean author acceptance', () => {
  const proposed = event({
    eventId: 'event-1',
    sequence: 1,
    action: 'propose',
    authority: 'model',
    actor: 'chat-a',
  });
  const verified = event({
    eventId: 'event-2',
    sequence: 2,
    previousEventId: 'event-1',
    action: 'verify',
    authority: 'external',
    actor: 'ci',
    provenance: ['github:check/123'],
  });

  const state = evaluateArtifactHistory('artifact-a', [proposed, verified]);
  assert.equal(state.state, 'OK');
  assert.equal(state.lifecycle, 'PROPOSED');
  assert.equal(state.verifications.length, 1);
  assert.equal(state.verifications[0].actor, 'ci');
});

test('accepted artifact can be explicitly superseded by author', () => {
  const history = [
    event({
      eventId: 'event-1',
      sequence: 1,
      action: 'propose',
      authority: 'model',
      actor: 'chat-a',
    }),
    event({
      eventId: 'event-2',
      sequence: 2,
      previousEventId: 'event-1',
      action: 'accept',
      authority: 'author',
      actor: 'user',
    }),
    event({
      eventId: 'event-3',
      sequence: 3,
      previousEventId: 'event-2',
      action: 'supersede',
      authority: 'author',
      actor: 'user',
      replacementArtifactId: 'artifact-b',
    }),
  ];

  const state = evaluateArtifactHistory('artifact-a', history);
  assert.equal(state.state, 'OK');
  assert.equal(state.lifecycle, 'SUPERSEDED');
  assert.equal(state.replacement_artifact_id, 'artifact-b');
});

test('gap and fork fail closed', () => {
  const first = event({
    eventId: 'event-1',
    sequence: 1,
    action: 'propose',
    authority: 'model',
    actor: 'chat-a',
  });
  const third = event({
    eventId: 'event-3',
    sequence: 3,
    previousEventId: 'event-2',
    action: 'accept',
    authority: 'author',
    actor: 'user',
  });

  const gap = evaluateArtifactHistory('artifact-a', [first, third]);
  assert.equal(gap.state, 'GAP_PENDING');
  assert.equal(gap.expected_sequence, 2);

  const fork = evaluateArtifactHistory('artifact-a', [
    first,
    event({
      eventId: 'event-1b',
      sequence: 1,
      action: 'observe',
      authority: 'system',
      actor: 'tool',
    }),
  ]);
  assert.equal(fork.state, 'ARTIFACT_EVENT_FORK');
});

test('append is immutable and duplicate-safe by event_id', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = event({
    eventId: 'event-1',
    sequence: 1,
    action: 'propose',
    authority: 'model',
    actor: 'chat-a',
  });

  assert.equal((await appendMemoryEvent(root, first)).status, 'appended');
  assert.equal((await appendMemoryEvent(root, structuredClone(first))).status, 'duplicate');

  const conflict = {
    ...first,
    actor: 'chat-b',
  };
  await assert.rejects(
    () => appendMemoryEvent(root, conflict),
    (error) => error instanceof MemoryEventError && error.code === 'EVENT_ID_CONFLICT',
  );
});

test('persistent state is rebuilt from append-only event journal', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await appendMemoryEvent(root, event({
    eventId: 'event-1',
    sequence: 1,
    action: 'propose',
    authority: 'model',
    actor: 'chat-a',
    provenance: ['chat:1'],
  }));
  await appendMemoryEvent(root, event({
    eventId: 'event-2',
    sequence: 2,
    previousEventId: 'event-1',
    action: 'accept',
    authority: 'author',
    actor: 'user',
    provenance: ['chat:2'],
  }));

  const first = await rebuildMemoryState(root, { now: () => 'first' });
  const second = await rebuildMemoryState(root, { now: () => 'second' });

  assert.equal(first.artifacts['artifact-a'].lifecycle, 'ACCEPTED');
  assert.deepEqual(first.artifacts, second.artifacts);
  assert.deepEqual(first.journal, second.journal);
  assert.notEqual(first.generated_at, second.generated_at);
});
