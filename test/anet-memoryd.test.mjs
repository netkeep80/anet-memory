import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEnvelope, serializeEnvelope } from '../src/sandbox-bus.mjs';
import { appendMemoryEvent, createMemoryEvent } from '../src/memory-events.mjs';
import {
  ingestEnvelope,
  rebuildState,
  startMemoryDaemon,
} from '../src/anet-memoryd.mjs';

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'anet-memoryd-'));
}

function message({
  sequence = 1,
  previousMessageId = null,
  messageId = `m-${sequence}`,
  source = 'thread-a',
  target = 'thread-b',
  payload = `payload-${sequence}`,
} = {}) {
  return createEnvelope({
    source,
    target,
    sequence,
    previousMessageId,
    messageId,
    payloadBytes: payload,
    contentType: 'text/plain; charset=utf-8',
    createdAt: `2026-10-07T20:${String(sequence).padStart(2, '0')}:00.000Z`,
  });
}

test('ingest is immutable and idempotent for the same envelope', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const envelope = message({ messageId: 'immutable-1' });
  const first = await ingestEnvelope(root, envelope);
  const second = await ingestEnvelope(root, structuredClone(envelope));

  assert.equal(first.status, 'ingested');
  assert.equal(second.status, 'duplicate');

  const conflict = {
    ...envelope,
    payload: Buffer.from('changed').toString('base64'),
  };
  assert.rejects(
    () => ingestEnvelope(root, conflict),
    (error) => error.code === 'PAYLOAD_HASH_MISMATCH' || error.code === 'MESSAGE_PATH_CONFLICT',
  );
});

test('rebuildState derives valid channel continuity from immutable inbox', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const m1 = message({ messageId: 'm1' });
  const m2 = message({ sequence: 2, previousMessageId: 'm1', messageId: 'm2' });
  await ingestEnvelope(root, m2);
  await ingestEnvelope(root, m1);

  const state = await rebuildState(root, { now: () => '2026-10-07T20:00:00.000Z' });
  assert.equal(state.journal.valid_messages, 2);
  assert.equal(state.journal.invalid_messages, 0);

  const channel = state.channels['thread-a->thread-b'];
  assert.equal(channel.state, 'OK');
  assert.equal(channel.accepted_count, 2);
  assert.deepEqual(channel.accepted_message_ids, ['m1', 'm2']);
  assert.equal(channel.next_sequence, 3);
  assert.equal(channel.previous_message_id, 'm2');

  const saved = JSON.parse(await readFile(path.join(root, 'views', 'state.json'), 'utf8'));
  assert.deepEqual(saved.channels, state.channels);
});

test('rebuild is deterministic in semantic content after restart', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await ingestEnvelope(root, message({ messageId: 'm1' }));
  await ingestEnvelope(root, message({ sequence: 2, previousMessageId: 'm1', messageId: 'm2' }));

  const first = await rebuildState(root, { now: () => 'first' });
  const second = await rebuildState(root, { now: () => 'second' });

  assert.deepEqual(first.journal, second.journal);
  assert.deepEqual(first.channels, second.channels);
  assert.notEqual(first.generated_at, second.generated_at);
});

test('gap and fork are preserved as fail-closed derived channel states', async (t) => {
  const gapRoot = await tempRoot();
  const forkRoot = await tempRoot();
  t.after(() => Promise.all([
    rm(gapRoot, { recursive: true, force: true }),
    rm(forkRoot, { recursive: true, force: true }),
  ]));

  await ingestEnvelope(gapRoot, message({ messageId: 'm1' }));
  await ingestEnvelope(gapRoot, message({ sequence: 3, previousMessageId: 'm2', messageId: 'm3' }));
  const gap = await rebuildState(gapRoot);
  assert.equal(gap.channels['thread-a->thread-b'].state, 'GAP_PENDING');
  assert.equal(gap.channels['thread-a->thread-b'].expected_sequence, 2);

  await ingestEnvelope(forkRoot, message({ messageId: 'fork-a' }));
  await ingestEnvelope(forkRoot, message({ messageId: 'fork-b' }));
  const fork = await rebuildState(forkRoot);
  assert.equal(fork.channels['thread-a->thread-b'].state, 'CHANNEL_FORK');
});

test('invalid inbox object is reported without destroying valid channel view', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await ingestEnvelope(root, message({ messageId: 'm1' }));
  const invalidDir = path.join(root, 'inbox', 'manual');
  await mkdir(invalidDir, { recursive: true });
  await writeFile(path.join(invalidDir, 'broken.json'), '{not-json', 'utf8');

  const state = await rebuildState(root);
  assert.equal(state.journal.valid_messages, 1);
  assert.equal(state.journal.invalid_messages, 1);
  assert.equal(state.channels['thread-a->thread-b'].state, 'OK');
});

test('HTTP API exposes health, ingest, state and background rescans on loopback', async (t) => {
  const root = await tempRoot();
  const daemon = await startMemoryDaemon({
    root,
    host: '127.0.0.1',
    port: 0,
    scanIntervalMs: 25,
  });
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${daemon.port}`;

  const healthResponse = await fetch(`${base}/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, 'ok');

  const first = message({ messageId: 'http-1' });
  const ingestResponse = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(first),
  });
  assert.equal(ingestResponse.status, 201);

  const stateResponse = await fetch(`${base}/state`);
  const state = await stateResponse.json();
  assert.equal(state.channels['thread-a->thread-b'].accepted_count, 1);

  const second = message({
    sequence: 2,
    previousMessageId: 'http-1',
    messageId: 'http-2',
  });
  await ingestEnvelope(root, second);

  await waitFor(async () => {
    const response = await fetch(`${base}/state`);
    const current = await response.json();
    return current.channels['thread-a->thread-b']?.accepted_count === 2;
  });

  const finalHealth = await (await fetch(`${base}/health`)).json();
  assert.ok(finalHealth.scan_count >= 2);
});

async function waitFor(predicate, { timeoutMs = 1500, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail('condition was not reached before timeout');
}


test('daemon exposes lifecycle memory state/current view and background event discovery', async (t) => {
  const root = await tempRoot();
  const daemon = await startMemoryDaemon({
    root,
    host: '127.0.0.1',
    port: 0,
    scanIntervalMs: 25,
  });
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${daemon.port}`;

  const proposal = createMemoryEvent({
    eventId: 'mem-event-1',
    artifactId: 'artifact-a',
    sequence: 1,
    previousEventId: null,
    action: 'propose',
    authority: 'model',
    actor: 'chat-a',
    provenance: ['chat:proposal'],
    createdAt: '2026-10-07T22:00:00.000Z',
  });

  const proposalResponse = await fetch(`${base}/memory/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(proposal),
  });
  assert.equal(proposalResponse.status, 201);

  let current = await (await fetch(`${base}/memory/current`)).json();
  assert.deepEqual(current.current.candidates.map((item) => item.artifact_id), ['artifact-a']);
  assert.equal(current.current.accepted.length, 0);

  const acceptance = createMemoryEvent({
    eventId: 'mem-event-2',
    artifactId: 'artifact-a',
    sequence: 2,
    previousEventId: 'mem-event-1',
    action: 'accept',
    authority: 'author',
    actor: 'user',
    provenance: ['chat:explicit-approval'],
    createdAt: '2026-10-07T22:01:00.000Z',
  });

  await appendMemoryEvent(path.join(root, 'memory'), acceptance);

  await waitFor(async () => {
    const response = await fetch(`${base}/memory/current`);
    const value = await response.json();
    return value.current.accepted.some((item) => item.artifact_id === 'artifact-a');
  });

  const memoryState = await (await fetch(`${base}/memory/state`)).json();
  current = await (await fetch(`${base}/memory/current`)).json();

  assert.equal(memoryState.artifacts['artifact-a'].lifecycle, 'ACCEPTED');
  assert.equal(current.current.accepted[0].artifact_id, 'artifact-a');
  assert.equal(
    current.source.journal_source_sha256,
    memoryState.journal.source_sha256,
  );

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(
    health.memory_journal_source_sha256,
    memoryState.journal.source_sha256,
  );
});


test('memory event immutable conflict is surfaced as HTTP 409', async (t) => {
  const root = await tempRoot();
  const daemon = await startMemoryDaemon({
    root,
    host: '127.0.0.1',
    port: 0,
    scanIntervalMs: 50,
  });
  t.after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${daemon.port}`;
  const first = createMemoryEvent({
    eventId: 'conflict-event-1',
    artifactId: 'artifact-conflict',
    sequence: 1,
    action: 'propose',
    authority: 'model',
    actor: 'chat-a',
    createdAt: '2026-10-07T22:10:00.000Z',
  });

  assert.equal((await fetch(`${base}/memory/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(first),
  })).status, 201);

  const conflicting = { ...first, actor: 'chat-b' };
  const response = await fetch(`${base}/memory/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(conflicting),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'EVENT_ID_CONFLICT');
});
