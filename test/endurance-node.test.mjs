import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptPeerEnvelope,
  createNextOutgoing,
  newExperimentState,
} from '../experiments/dual-thread-endurance/node.mjs';

const health = { started_at: '2026-10-07T20:00:00Z', uptime_ms: 1000, scan_count: 10 };

test('two nodes can advance lock-step ordered channels', () => {
  let a = newExperimentState({ runId: 'run-1', node: 'thread-a', peer: 'thread-b', startedAt: 't0' });
  let b = newExperimentState({ runId: 'run-1', node: 'thread-b', peer: 'thread-a', startedAt: 't0' });

  const a1 = createNextOutgoing(a, health, { now: 't1', messageId: 'thread-a-m1' });
  a = a1.state;
  const b1 = createNextOutgoing(b, health, { now: 't1', messageId: 'thread-b-m1' });
  b = b1.state;

  const bAcceptsA1 = acceptPeerEnvelope(b, a1.envelope);
  assert.equal(bAcceptsA1.status, 'accepted');
  b = bAcceptsA1.state;
  const b2 = createNextOutgoing(b, health, { now: 't2', messageId: 'thread-b-m2' });
  b = b2.state;

  const aAcceptsB1 = acceptPeerEnvelope(a, b1.envelope);
  assert.equal(aAcceptsB1.status, 'accepted');
  a = aAcceptsB1.state;
  const a2 = createNextOutgoing(a, health, { now: 't2', messageId: 'thread-a-m2' });
  a = a2.state;

  const aAcceptsB2 = acceptPeerEnvelope(a, b2.envelope);
  a = aAcceptsB2.state;
  const bAcceptsA2 = acceptPeerEnvelope(b, a2.envelope);
  b = bAcceptsA2.state;

  assert.equal(a.last_peer_sequence, 2);
  assert.equal(b.last_peer_sequence, 2);
  assert.equal(a.next_outgoing_sequence, 3);
  assert.equal(b.next_outgoing_sequence, 3);
  assert.equal(a.previous_outgoing_message_id, 'thread-a-m2');
  assert.equal(b.previous_outgoing_message_id, 'thread-b-m2');
});

test('duplicate peer event does not advance state or authorize another reply', () => {
  let a = newExperimentState({ runId: 'run-1', node: 'thread-a', peer: 'thread-b' });
  const b = newExperimentState({ runId: 'run-1', node: 'thread-b', peer: 'thread-a' });
  const b1 = createNextOutgoing(b, health, { messageId: 'thread-b-m1' });
  const first = acceptPeerEnvelope(a, b1.envelope);
  assert.equal(first.status, 'accepted');
  const second = acceptPeerEnvelope(first.state, b1.envelope);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.state.last_peer_sequence, 1);
  assert.equal(second.state.received_count, 1);
});

test('peer sequence gap fails closed', () => {
  const a = newExperimentState({ runId: 'run-1', node: 'thread-a', peer: 'thread-b' });
  let b = newExperimentState({ runId: 'run-1', node: 'thread-b', peer: 'thread-a' });
  const b1 = createNextOutgoing(b, health, { messageId: 'thread-b-m1' });
  b = b1.state;
  const accepted = acceptPeerEnvelope(a, b1.envelope).state;
  const b2 = createNextOutgoing(b, health, { messageId: 'thread-b-m2' });
  b = b2.state;
  const b3 = createNextOutgoing(b, health, { messageId: 'thread-b-m3' });
  assert.throws(() => acceptPeerEnvelope(accepted, b3.envelope), (error) => error.code === 'PEER_SEQUENCE_GAP');
});
