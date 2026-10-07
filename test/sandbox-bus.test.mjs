import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SandboxBusError,
  channelRelativePath,
  createAckEnvelope,
  createEnvelope,
  decodePayload,
  inspectChannel,
  messageFilename,
  parseEnvelope,
  readAck,
  recoverProducerState,
  serializeEnvelope,
  validateEnvelope,
} from '../src/sandbox-bus.mjs';

function message(sequence, previousMessageId, messageId = `m-${sequence}`, payload = `payload-${sequence}`) {
  return createEnvelope({
    source: 'thread-a',
    target: 'thread-b',
    sequence,
    previousMessageId,
    messageId,
    payloadBytes: payload,
    contentType: 'text/plain; charset=utf-8',
    createdAt: `2026-10-07T19:${String(sequence).padStart(2, '0')}:00.000Z`,
  });
}

test('payload hash validates exact bytes and detects tampering', () => {
  const envelope = message(1, null);
  assert.equal(decodePayload(envelope).toString('utf8'), 'payload-1');

  const tampered = { ...envelope, payload: Buffer.from('different').toString('base64') };
  assert.throws(() => validateEnvelope(tampered), (error) => {
    assert.equal(error.code, 'PAYLOAD_HASH_MISMATCH');
    return true;
  });
});

test('valid chain recovers next sequence from continuity, not max alone', () => {
  const m1 = message(1, null, 'm1');
  const m2 = message(2, 'm1', 'm2');
  const m3 = message(3, 'm2', 'm3');

  const state = inspectChannel([m3, m1, m2], { source: 'thread-a', target: 'thread-b' });
  assert.equal(state.state, 'OK');
  assert.equal(state.next_sequence, 4);
  assert.equal(state.previous_message_id, 'm3');

  assert.deepEqual(recoverProducerState([m1, m2, m3], { source: 'thread-a', target: 'thread-b' }), {
    next_sequence: 4,
    previous_message_id: 'm3',
  });
});

test('same logical message discovered twice is deduplicated by message_id', () => {
  const m1 = message(1, null, 'same-id');
  const state = inspectChannel([m1, structuredClone(m1)], { source: 'thread-a', target: 'thread-b' });
  assert.equal(state.state, 'OK');
  assert.equal(state.accepted.length, 1);
  assert.equal(state.duplicate_count, 1);
});

test('same message_id with different logical content is a hard conflict', () => {
  const first = message(1, null, 'same-id', 'one');
  const second = message(1, null, 'same-id', 'two');
  const state = inspectChannel([first, second], { source: 'thread-a', target: 'thread-b' });
  assert.equal(state.state, 'MESSAGE_ID_CONFLICT');
});

test('same sequence with different message_id is CHANNEL_FORK', () => {
  const a = message(1, null, 'fork-a');
  const b = message(1, null, 'fork-b');
  const state = inspectChannel([a, b], { source: 'thread-a', target: 'thread-b' });
  assert.equal(state.state, 'CHANNEL_FORK');
  assert.equal(state.details.sequence, 1);
});

test('missing sequence is GAP_PENDING and later message is not accepted', () => {
  const m1 = message(1, null, 'm1');
  const m3 = message(3, 'm2', 'm3');
  const state = inspectChannel([m1, m3], { source: 'thread-a', target: 'thread-b' });
  assert.equal(state.state, 'GAP_PENDING');
  assert.equal(state.reason, 'SEQUENCE_GAP');
  assert.equal(state.expected_sequence, 2);
  assert.deepEqual(state.accepted.map((m) => m.message_id), ['m1']);
});

test('broken previous_message_id is GAP_PENDING', () => {
  const m1 = message(1, null, 'm1');
  const m2 = message(2, 'other', 'm2');
  const state = inspectChannel([m1, m2], { source: 'thread-a', target: 'thread-b' });
  assert.equal(state.state, 'GAP_PENDING');
  assert.equal(state.reason, 'PREVIOUS_MESSAGE_MISMATCH');
  assert.equal(state.expected_previous_message_id, 'm1');
});

test('sequence is local to each (source,target) channel', () => {
  const ab = createEnvelope({ source: 'thread-a', target: 'thread-b', sequence: 1, payloadBytes: 'ab', messageId: 'ab-1' });
  const ac = createEnvelope({ source: 'thread-a', target: 'thread-c', sequence: 1, payloadBytes: 'ac', messageId: 'ac-1' });

  const abState = inspectChannel([ab, ac], { source: 'thread-a', target: 'thread-b' });
  const acState = inspectChannel([ab, ac], { source: 'thread-a', target: 'thread-c' });
  assert.equal(abState.next_sequence, 2);
  assert.equal(acState.next_sequence, 2);
});

test('ACK is an ordinary reverse-channel event with hashed payload bytes', () => {
  const request = message(1, null, 'request-1');
  const ack = createAckEnvelope({
    source: 'thread-b',
    target: 'thread-a',
    sequence: 1,
    previousMessageId: null,
    messageId: 'ack-1',
    ackFor: request.message_id,
    status: 'processed',
    detail: 'ok',
    createdAt: '2026-10-07T19:10:00.000Z',
  });

  assert.deepEqual(readAck(ack), { ack_for: 'request-1', status: 'processed', detail: 'ok' });
  const reverse = inspectChannel([ack], { source: 'thread-b', target: 'thread-a' });
  assert.equal(reverse.state, 'OK');
  assert.equal(reverse.next_sequence, 2);
});

test('filename is only a sortable index; envelope remains authoritative', () => {
  const envelope = message(7, 'm6', 'independent-id');
  assert.equal(messageFilename(envelope), '000000000007--independent-id.json');
  assert.equal(channelRelativePath(envelope), 'sandbox-bus/v1/messages/thread-a/thread-b/000000000007--independent-id.json');

  const roundTrip = parseEnvelope(serializeEnvelope(envelope));
  assert.equal(roundTrip.sequence, 7);
  assert.equal(roundTrip.message_id, 'independent-id');
});

test('producer recovery fails closed on fork/gap', () => {
  const m1 = message(1, null, 'm1');
  const m3 = message(3, 'm2', 'm3');
  assert.throws(
    () => recoverProducerState([m1, m3], { source: 'thread-a', target: 'thread-b' }),
    (error) => error instanceof SandboxBusError && error.code === 'GAP_PENDING',
  );
});


test('message_id is path-safe before filename construction', () => {
  for (const unsafe of ['../x', 'a/b', 'a\\\\b', '', 'x'.repeat(201)]) {
    assert.throws(
      () => createEnvelope({
        source: 'thread-a',
        target: 'thread-b',
        sequence: 1,
        messageId: unsafe,
        payloadBytes: 'x',
      }),
      (error) => error instanceof SandboxBusError && error.code === 'INVALID_MESSAGE_ID',
      unsafe,
    );
  }

  const safe = createEnvelope({
    source: 'thread-a',
    target: 'thread-b',
    sequence: 1,
    messageId: 'thread-a:01K.test_123-abc',
    payloadBytes: 'x',
  });
  assert.equal(
    messageFilename(safe),
    '000000000001--thread-a:01K.test_123-abc.json',
  );
});

test('externally supplied unsafe message_id is rejected by validation', () => {
  const envelope = message(1, null, 'safe-id');
  const unsafe = { ...envelope, message_id: '../escape' };
  assert.throws(
    () => validateEnvelope(unsafe),
    (error) => error instanceof SandboxBusError && error.code === 'INVALID_MESSAGE_ID',
  );
});
