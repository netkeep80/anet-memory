import test from 'node:test';
import assert from 'node:assert/strict';

import { createEnvelope, serializeEnvelope, sha256Hex } from '../src/sandbox-bus.mjs';
import { inspectClosedBatch, inspectCompetingManifests } from '../experiments/commit-boundary/closed-batch.mjs';

const SOURCE = 'research-writer';
const TARGET = 'research-reader';

function envelope(id, sequence, prev = null, payload = id) {
  return createEnvelope({
    source: SOURCE,
    target: TARGET,
    sequence,
    previousMessageId: prev,
    messageId: id,
    payloadBytes: payload,
    createdAt: '2026-10-08T09:00:00.000Z',
  });
}

function fixture(messages) {
  const objects = new Map();
  const entries = messages.map((m) => {
    const path = `messages/${m.message_id}.json`;
    const bytes = Buffer.from(serializeEnvelope(m));
    objects.set(path, bytes);
    return { path, message_id: m.message_id, sequence: m.sequence, size_bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
  });
  const manifest = { protocol: 'anet-closed-batch/research-1', run_id: 'fixture-1', epoch: 'E1', source: SOURCE, target: TARGET, object_count: entries.length, entries };
  return { manifest, objects };
}

test('manifest visible first, objects absent => no commit and no effects', () => {
  const { manifest } = fixture([envelope('m1', 1), envelope('m2', 2, 'm1')]);
  assert.deepEqual(inspectClosedBatch(manifest, new Map()).missing, ['messages/m1.json', 'messages/m2.json']);
  assert.equal(inspectClosedBatch(manifest, new Map()).state, 'MISSING_DEPENDENCY');
  assert.equal(inspectClosedBatch(manifest, new Map()).effect_allowed, false);
});

test('out-of-order seq=2 alone is never accepted as closed batch', () => {
  const { manifest, objects } = fixture([envelope('m1', 1), envelope('m2', 2, 'm1')]);
  objects.delete('messages/m1.json');
  const verdict = inspectClosedBatch(manifest, objects);
  assert.equal(verdict.state, 'MISSING_DEPENDENCY');
  assert.equal(verdict.observed_channel_state, 'GAP_PENDING');
  assert.equal(verdict.effect_allowed, false);
});

test('complete exact two-message chain is only BATCH_COMPLETE, not COMMITTED', () => {
  const { manifest, objects } = fixture([envelope('m1', 1), envelope('m2', 2, 'm1')]);
  const verdict = inspectClosedBatch(manifest, objects);
  assert.equal(verdict.state, 'BATCH_COMPLETE');
  assert.equal(verdict.verified, 2);
  assert.equal(verdict.channel_next_sequence, 3);
  assert.equal(verdict.authority, 'UNVERIFIED');
  assert.equal(verdict.effect_allowed, false);
});

test('incorrect size, SHA and envelope identity fail closed', () => {
  const { manifest, objects } = fixture([envelope('m1', 1)]);
  objects.set('messages/m1.json', Buffer.from('tampered'));
  assert.equal(inspectClosedBatch(manifest, objects).reason, 'size_mismatch');

  const { manifest: m2, objects: o2 } = fixture([envelope('m1', 1)]);
  const bytes = o2.get('messages/m1.json');
  o2.set('messages/m1.json', Buffer.from(bytes.toString().replace('payload_sha256', 'payload_sha256X')));
  assert.equal(inspectClosedBatch(m2, o2).state, 'INVALID_OBJECT');

  const { manifest: m3, objects: o3 } = fixture([envelope('m1', 1)]);
  m3.entries[0].message_id = 'different';
  assert.equal(inspectClosedBatch(m3, o3).reason, 'identity_mismatch');
});

test('malformed/duplicate paths and inconsistent object count are rejected', () => {
  const { manifest } = fixture([envelope('m1', 1)]);
  assert.equal(inspectClosedBatch({ ...manifest, object_count: 2 }, new Map()).reason, 'object_count');
  assert.equal(inspectClosedBatch({ ...manifest, entries: [manifest.entries[0], manifest.entries[0]], object_count: 2 }, new Map()).reason, 'duplicate_path');
  assert.equal(inspectClosedBatch({ ...manifest, entries: [{ ...manifest.entries[0], path: 'messages/../bad.json' }] }, new Map()).reason, 'unsafe_path');
});

test('two divergent valid genesis envelopes in one manifest are a known CHANNEL_FORK', () => {
  const { manifest, objects } = fixture([envelope('m1', 1, null, 'A'), envelope('m1-other', 1, null, 'B')]);
  const v = inspectClosedBatch(manifest, objects);
  assert.equal(v.state, 'CHANNEL_FORK');
  assert.equal(v.effect_allowed, false);
});

test('one observed manifest cannot prove there is no competing unseen manifest', () => {
  const { manifest } = fixture([envelope('m1', 1)]);
  const v = inspectCompetingManifests([manifest]);
  assert.equal(v.state, 'NO_OBSERVED_CONFLICT');
  assert.equal(v.effect_allowed, false);
});

test('two conflicting manifests for same run/epoch are detected, irrespective of order', () => {
  const { manifest } = fixture([envelope('m1', 1)]);
  const divergent = { ...manifest, object_count: 1, entries: [{ ...manifest.entries[0], message_id: 'other', sha256: 'a'.repeat(64) }] };
  for (const order of [[manifest, divergent], [divergent, manifest]]) {
    const v = inspectCompetingManifests(order);
    assert.equal(v.state, 'COMPETING_MANIFESTS');
    assert.equal(v.effect_allowed, false);
  }
});

test('duplicate identical manifests are not competing but never confer authority', () => {
  const { manifest } = fixture([envelope('m1', 1)]);
  const v = inspectCompetingManifests([manifest, structuredClone(manifest)]);
  assert.equal(v.state, 'NO_OBSERVED_CONFLICT');
  assert.equal(v.effect_allowed, false);
});

test('unexpected/stray Library object cannot silently enter a closed manifest', () => {
  const { manifest, objects } = fixture([envelope('m1', 1)]);
  objects.set('messages/unlisted.json', Buffer.from('arbitrary untrusted bytes'));
  const v = inspectClosedBatch(manifest, objects);
  assert.equal(v.state, 'BATCH_COMPLETE');
  assert.equal(v.effect_allowed, false);
  // Unlisted Library bytes are NOT part of this manifest, even if present in a folder scan.
});
