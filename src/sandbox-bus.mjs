import { createHash, randomUUID } from 'node:crypto';

export const SANDBOX_BUS_PROTOCOL = 'sandbox-bus/1';
export const ACK_STATUSES = new Set(['received', 'processed', 'rejected']);

const NODE_ID_RE = /^[A-Za-z0-9._-]+$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class SandboxBusError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SandboxBusError';
    this.code = code;
    this.details = details;
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(toBuffer(bytes)).digest('hex');
}

export function createEnvelope({
  type = 'message',
  messageId = randomUUID(),
  source,
  target,
  sequence,
  previousMessageId = null,
  createdAt = new Date().toISOString(),
  contentType = 'application/octet-stream',
  payloadBytes = Buffer.alloc(0),
  transportMeta,
} = {}) {
  assertNodeId(source, 'source');
  assertNodeId(target, 'target');
  assertSequence(sequence);
  assertNonEmptyString(messageId, 'messageId');
  assertNonEmptyString(type, 'type');
  assertNonEmptyString(contentType, 'contentType');

  if (sequence === 1 && previousMessageId !== null) {
    throw new SandboxBusError('INVALID_GENESIS', 'sequence=1 requires previous_message_id=null');
  }
  if (sequence > 1 && !isNonEmptyString(previousMessageId)) {
    throw new SandboxBusError('MISSING_PREVIOUS_MESSAGE', 'sequence>1 requires previous_message_id');
  }

  const payload = toBuffer(payloadBytes);
  const envelope = {
    protocol: SANDBOX_BUS_PROTOCOL,
    type,
    message_id: messageId,
    source,
    target,
    sequence,
    previous_message_id: previousMessageId,
    created_at: createdAt,
    content_type: contentType,
    payload_encoding: 'base64',
    payload: payload.toString('base64'),
    payload_sha256: sha256Hex(payload),
  };

  if (transportMeta !== undefined) {
    envelope.transport_meta = transportMeta;
  }

  return envelope;
}

export function createAckEnvelope({
  source,
  target,
  sequence,
  previousMessageId = null,
  ackFor,
  status,
  detail = null,
  messageId,
  createdAt,
  transportMeta,
} = {}) {
  assertNonEmptyString(ackFor, 'ackFor');
  if (!ACK_STATUSES.has(status)) {
    throw new SandboxBusError('INVALID_ACK_STATUS', `unsupported ACK status: ${status}`);
  }

  const body = Buffer.from(JSON.stringify({ ack_for: ackFor, status, detail }), 'utf8');
  return createEnvelope({
    type: 'ack',
    messageId,
    source,
    target,
    sequence,
    previousMessageId,
    createdAt,
    contentType: 'application/vnd.sandbox-bus.ack+json',
    payloadBytes: body,
    transportMeta,
  });
}

export function decodePayload(envelope) {
  validateEnvelope(envelope);
  return Buffer.from(envelope.payload, 'base64');
}

export function readAck(envelope) {
  validateEnvelope(envelope);
  if (envelope.type !== 'ack') {
    throw new SandboxBusError('NOT_ACK', 'envelope type is not ack');
  }

  let value;
  try {
    value = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  } catch (error) {
    throw new SandboxBusError('INVALID_ACK_BODY', 'ACK payload is not valid JSON', { cause: error.message });
  }

  if (!isNonEmptyString(value?.ack_for) || !ACK_STATUSES.has(value?.status)) {
    throw new SandboxBusError('INVALID_ACK_BODY', 'ACK payload must contain ack_for and a valid status');
  }
  return value;
}

export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new SandboxBusError('INVALID_ENVELOPE', 'envelope must be an object');
  }
  if (envelope.protocol !== SANDBOX_BUS_PROTOCOL) {
    throw new SandboxBusError('UNSUPPORTED_PROTOCOL', `expected ${SANDBOX_BUS_PROTOCOL}`);
  }

  assertNonEmptyString(envelope.type, 'type');
  assertNonEmptyString(envelope.message_id, 'message_id');
  assertNodeId(envelope.source, 'source');
  assertNodeId(envelope.target, 'target');
  assertSequence(envelope.sequence);
  assertNonEmptyString(envelope.created_at, 'created_at');
  assertNonEmptyString(envelope.content_type, 'content_type');

  if (envelope.sequence === 1 && envelope.previous_message_id !== null) {
    throw new SandboxBusError('INVALID_GENESIS', 'sequence=1 requires previous_message_id=null');
  }
  if (envelope.sequence > 1 && !isNonEmptyString(envelope.previous_message_id)) {
    throw new SandboxBusError('MISSING_PREVIOUS_MESSAGE', 'sequence>1 requires previous_message_id');
  }
  if (envelope.payload_encoding !== 'base64') {
    throw new SandboxBusError('UNSUPPORTED_PAYLOAD_ENCODING', 'payload_encoding must be base64');
  }
  if (typeof envelope.payload !== 'string' || !isCanonicalBase64(envelope.payload)) {
    throw new SandboxBusError('INVALID_PAYLOAD_ENCODING', 'payload is not canonical base64');
  }
  if (!/^[0-9a-f]{64}$/.test(envelope.payload_sha256 ?? '')) {
    throw new SandboxBusError('INVALID_PAYLOAD_HASH', 'payload_sha256 must be lowercase SHA-256 hex');
  }

  const actualHash = sha256Hex(Buffer.from(envelope.payload, 'base64'));
  if (actualHash !== envelope.payload_sha256) {
    throw new SandboxBusError('PAYLOAD_HASH_MISMATCH', 'payload SHA-256 does not match envelope', {
      expected: envelope.payload_sha256,
      actual: actualHash,
    });
  }

  if (envelope.type === 'ack') {
    readAckBodyWithoutRevalidation(envelope);
  }

  return envelope;
}

export function inspectChannel(envelopes, { source, target } = {}) {
  assertNodeId(source, 'source');
  assertNodeId(target, 'target');
  if (!Array.isArray(envelopes)) {
    throw new SandboxBusError('INVALID_CHANNEL_INPUT', 'envelopes must be an array');
  }

  const byId = new Map();
  let duplicateCount = 0;

  for (const envelope of envelopes) {
    try {
      validateEnvelope(envelope);
    } catch (error) {
      return channelError('INVALID_MESSAGE', { error });
    }

    if (envelope.source !== source || envelope.target !== target) {
      continue;
    }

    const prior = byId.get(envelope.message_id);
    if (prior) {
      if (logicalFingerprint(prior) !== logicalFingerprint(envelope)) {
        return channelError('MESSAGE_ID_CONFLICT', {
          message_id: envelope.message_id,
          first: prior,
          second: envelope,
        });
      }
      duplicateCount += 1;
      continue;
    }
    byId.set(envelope.message_id, envelope);
  }

  const messages = [...byId.values()].sort((a, b) => a.sequence - b.sequence || a.message_id.localeCompare(b.message_id));
  const bySequence = new Map();
  for (const message of messages) {
    const sameSequence = bySequence.get(message.sequence) ?? [];
    sameSequence.push(message);
    bySequence.set(message.sequence, sameSequence);
  }

  for (const [sequence, sameSequence] of bySequence) {
    if (sameSequence.length > 1) {
      return channelError('CHANNEL_FORK', {
        sequence,
        message_ids: sameSequence.map((message) => message.message_id),
      });
    }
  }

  let expectedSequence = 1;
  let previousMessageId = null;
  const accepted = [];

  for (const message of messages) {
    if (message.sequence !== expectedSequence) {
      return {
        state: 'GAP_PENDING',
        reason: 'SEQUENCE_GAP',
        expected_sequence: expectedSequence,
        visible_sequence: message.sequence,
        last_accepted: accepted.at(-1) ?? null,
        accepted,
        duplicate_count: duplicateCount,
      };
    }

    if (message.previous_message_id !== previousMessageId) {
      return {
        state: 'GAP_PENDING',
        reason: 'PREVIOUS_MESSAGE_MISMATCH',
        expected_previous_message_id: previousMessageId,
        visible_previous_message_id: message.previous_message_id,
        visible_sequence: message.sequence,
        last_accepted: accepted.at(-1) ?? null,
        accepted,
        duplicate_count: duplicateCount,
      };
    }

    accepted.push(message);
    previousMessageId = message.message_id;
    expectedSequence += 1;
  }

  return {
    state: 'OK',
    accepted,
    last_accepted: accepted.at(-1) ?? null,
    next_sequence: expectedSequence,
    previous_message_id: previousMessageId,
    duplicate_count: duplicateCount,
  };
}

export function recoverProducerState(envelopes, channel) {
  const inspection = inspectChannel(envelopes, channel);
  if (inspection.state !== 'OK') {
    throw new SandboxBusError(inspection.state, `cannot recover producer state: ${inspection.state}`, inspection);
  }
  return {
    next_sequence: inspection.next_sequence,
    previous_message_id: inspection.previous_message_id,
  };
}

export function serializeEnvelope(envelope) {
  validateEnvelope(envelope);
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function parseEnvelope(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new SandboxBusError('INVALID_JSON', 'message file is not valid JSON', { cause: error.message });
  }
  return validateEnvelope(envelope);
}

export function messageFilename(envelope) {
  validateEnvelope(envelope);
  return `${String(envelope.sequence).padStart(12, '0')}--${envelope.message_id}.json`;
}

export function channelRelativePath(envelope) {
  validateEnvelope(envelope);
  return `sandbox-bus/v1/messages/${envelope.source}/${envelope.target}/${messageFilename(envelope)}`;
}

function readAckBodyWithoutRevalidation(envelope) {
  let value;
  try {
    value = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  } catch (error) {
    throw new SandboxBusError('INVALID_ACK_BODY', 'ACK payload is not valid JSON', { cause: error.message });
  }
  if (!isNonEmptyString(value?.ack_for) || !ACK_STATUSES.has(value?.status)) {
    throw new SandboxBusError('INVALID_ACK_BODY', 'ACK payload must contain ack_for and a valid status');
  }
}

function logicalFingerprint(envelope) {
  return JSON.stringify({
    protocol: envelope.protocol,
    type: envelope.type,
    message_id: envelope.message_id,
    source: envelope.source,
    target: envelope.target,
    sequence: envelope.sequence,
    previous_message_id: envelope.previous_message_id,
    content_type: envelope.content_type,
    payload_encoding: envelope.payload_encoding,
    payload: envelope.payload,
    payload_sha256: envelope.payload_sha256,
  });
}

function channelError(state, details) {
  return {
    state,
    accepted: [],
    last_accepted: null,
    duplicate_count: 0,
    details,
  };
}

function assertNodeId(value, field) {
  if (!isNonEmptyString(value) || !NODE_ID_RE.test(value)) {
    throw new SandboxBusError('INVALID_NODE_ID', `${field} must match ${NODE_ID_RE}`);
  }
}

function assertSequence(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SandboxBusError('INVALID_SEQUENCE', 'sequence must be a positive safe integer');
  }
}

function assertNonEmptyString(value, field) {
  if (!isNonEmptyString(value)) {
    throw new SandboxBusError('INVALID_FIELD', `${field} must be a non-empty string`);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isCanonicalBase64(value) {
  if (!BASE64_RE.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new SandboxBusError('INVALID_PAYLOAD', 'payloadBytes must be Buffer, Uint8Array, or string');
}
