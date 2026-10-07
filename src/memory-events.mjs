import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MEMORY_EVENT_PROTOCOL = 'anet-memory/event/1';

export const MEMORY_EVENT_ACTIONS = new Set([
  'propose',
  'observe',
  'accept',
  'verify',
  'reject',
  'supersede',
]);

export const MEMORY_AUTHORITIES = new Set([
  'model',
  'author',
  'external',
  'system',
]);

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class MemoryEventError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryEventError';
    this.code = code;
    this.details = details;
  }
}

export function createMemoryEvent({
  eventId,
  artifactId,
  sequence,
  previousEventId = null,
  action,
  authority,
  actor,
  createdAt = new Date().toISOString(),
  provenance = [],
  replacementArtifactId,
  note,
} = {}) {
  const event = {
    protocol: MEMORY_EVENT_PROTOCOL,
    event_id: eventId,
    artifact_id: artifactId,
    sequence,
    previous_event_id: previousEventId,
    action,
    authority,
    actor,
    created_at: createdAt,
    provenance,
  };

  if (replacementArtifactId !== undefined) {
    event.replacement_artifact_id = replacementArtifactId;
  }
  if (note !== undefined) {
    event.note = note;
  }

  return validateMemoryEvent(event);
}

export function validateMemoryEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new MemoryEventError('INVALID_EVENT', 'memory event must be an object');
  }
  if (event.protocol !== MEMORY_EVENT_PROTOCOL) {
    throw new MemoryEventError('UNSUPPORTED_PROTOCOL', `expected ${MEMORY_EVENT_PROTOCOL}`);
  }

  assertSafeId(event.event_id, 'event_id');
  assertSafeId(event.artifact_id, 'artifact_id');
  assertSequence(event.sequence);
  assertString(event.action, 'action');
  assertString(event.authority, 'authority');
  assertString(event.actor, 'actor');
  assertString(event.created_at, 'created_at');

  if (!MEMORY_EVENT_ACTIONS.has(event.action)) {
    throw new MemoryEventError('INVALID_ACTION', `unsupported memory action: ${event.action}`);
  }
  if (!MEMORY_AUTHORITIES.has(event.authority)) {
    throw new MemoryEventError('INVALID_AUTHORITY', `unsupported authority: ${event.authority}`);
  }

  if (event.sequence === 1 && event.previous_event_id !== null) {
    throw new MemoryEventError('INVALID_GENESIS', 'sequence=1 requires previous_event_id=null');
  }
  if (event.sequence > 1) {
    assertSafeId(event.previous_event_id, 'previous_event_id');
  }

  if (!Array.isArray(event.provenance) || event.provenance.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new MemoryEventError('INVALID_PROVENANCE', 'provenance must be an array of non-empty strings');
  }

  if (event.action === 'supersede') {
    assertSafeId(event.replacement_artifact_id, 'replacement_artifact_id');
    if (event.replacement_artifact_id === event.artifact_id) {
      throw new MemoryEventError('INVALID_SUPERSESSION', 'artifact cannot supersede itself');
    }
  } else if (event.replacement_artifact_id !== undefined) {
    throw new MemoryEventError('UNEXPECTED_REPLACEMENT', 'replacement_artifact_id is only valid for supersede');
  }

  if (event.note !== undefined && typeof event.note !== 'string') {
    throw new MemoryEventError('INVALID_NOTE', 'note must be a string when present');
  }

  return event;
}

export function serializeMemoryEvent(event) {
  validateMemoryEvent(event);
  return `${JSON.stringify(event, null, 2)}\n`;
}

export function parseMemoryEvent(text) {
  let event;
  try {
    event = JSON.parse(text);
  } catch (error) {
    throw new MemoryEventError('INVALID_JSON', 'memory event is not valid JSON', {
      cause: error.message,
    });
  }
  return validateMemoryEvent(event);
}

export async function appendMemoryEvent(root, event) {
  validateMemoryEvent(event);
  const eventRoot = path.join(path.resolve(root), 'events');
  await mkdir(eventRoot, { recursive: true });

  const destination = path.join(eventRoot, `${event.event_id}.json`);
  const serialized = serializeMemoryEvent(event);

  let existingText = null;
  try {
    existingText = await readFile(destination, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (existingText !== null) {
    const existing = parseMemoryEvent(existingText);
    if (stableJson(existing) === stableJson(event)) {
      return {
        status: 'duplicate',
        path: destination,
        event_id: event.event_id,
      };
    }
    throw new MemoryEventError('EVENT_ID_CONFLICT', 'event_id already exists with different immutable content', {
      event_id: event.event_id,
      path: destination,
    });
  }

  await atomicWrite(destination, serialized);
  return {
    status: 'appended',
    path: destination,
    event_id: event.event_id,
  };
}

export async function rebuildMemoryState(root, { now = () => new Date().toISOString() } = {}) {
  const absoluteRoot = path.resolve(root);
  const eventRoot = path.join(absoluteRoot, 'events');
  const files = await listJsonFiles(eventRoot);

  const invalid = [];
  const groups = new Map();
  const sourceSha256 = await hashJournalFiles(files, eventRoot);

  for (const file of files) {
    try {
      const event = parseMemoryEvent(await readFile(file, 'utf8'));
      const group = groups.get(event.artifact_id) ?? [];
      group.push(event);
      groups.set(event.artifact_id, group);
    } catch (error) {
      invalid.push({
        path: path.relative(absoluteRoot, file).split(path.sep).join('/'),
        code: error?.code ?? 'READ_OR_PARSE_ERROR',
        message: error?.message ?? String(error),
      });
    }
  }

  const artifacts = {};
  for (const [artifactId, events] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    artifacts[artifactId] = evaluateArtifactHistory(artifactId, events);
  }

  return {
    protocol: 'anet-memory/state-v1',
    generated_at: now(),
    journal: {
      files: files.length,
      invalid_events: invalid.length,
      source_sha256: sourceSha256,
      invalid,
    },
    artifacts,
  };
}

export function evaluateArtifactHistory(artifactId, events) {
  assertSafeId(artifactId, 'artifactId');
  if (!Array.isArray(events)) {
    throw new MemoryEventError('INVALID_HISTORY', 'events must be an array');
  }

  const byId = new Map();
  let duplicateCount = 0;

  for (const event of events) {
    validateMemoryEvent(event);
    if (event.artifact_id !== artifactId) continue;

    const prior = byId.get(event.event_id);
    if (prior) {
      if (stableJson(prior) !== stableJson(event)) {
        return historyError('EVENT_ID_CONFLICT', {
          event_id: event.event_id,
        });
      }
      duplicateCount += 1;
      continue;
    }
    byId.set(event.event_id, event);
  }

  const ordered = [...byId.values()].sort((a, b) => a.sequence - b.sequence || a.event_id.localeCompare(b.event_id));
  const bySequence = new Map();
  for (const event of ordered) {
    const same = bySequence.get(event.sequence) ?? [];
    same.push(event);
    bySequence.set(event.sequence, same);
  }

  for (const [sequence, same] of bySequence) {
    if (same.length > 1) {
      return historyError('ARTIFACT_EVENT_FORK', {
        sequence,
        event_ids: same.map((event) => event.event_id),
      });
    }
  }

  let expectedSequence = 1;
  let previousEventId = null;
  const acceptedEvents = [];

  let lifecycle = 'UNKNOWN';
  let acceptedBy = null;
  let replacementArtifactId = null;
  const verifications = [];
  const authorityErrors = [];

  for (const event of ordered) {
    if (event.sequence !== expectedSequence) {
      return {
        state: 'GAP_PENDING',
        reason: 'SEQUENCE_GAP',
        artifact_id: artifactId,
        lifecycle,
        expected_sequence: expectedSequence,
        visible_sequence: event.sequence,
        accepted_events: acceptedEvents.map((item) => item.event_id),
        duplicate_count: duplicateCount,
      };
    }

    if (event.previous_event_id !== previousEventId) {
      return {
        state: 'GAP_PENDING',
        reason: 'PREVIOUS_EVENT_MISMATCH',
        artifact_id: artifactId,
        lifecycle,
        expected_previous_event_id: previousEventId,
        visible_previous_event_id: event.previous_event_id,
        visible_sequence: event.sequence,
        accepted_events: acceptedEvents.map((item) => item.event_id),
        duplicate_count: duplicateCount,
      };
    }

    const policy = applyLifecycleEvent({
      lifecycle,
      acceptedBy,
      replacementArtifactId,
      verifications,
      authorityErrors,
    }, event);

    lifecycle = policy.lifecycle;
    acceptedBy = policy.acceptedBy;
    replacementArtifactId = policy.replacementArtifactId;
    acceptedEvents.push(event);
    previousEventId = event.event_id;
    expectedSequence += 1;
  }

  return {
    state: authorityErrors.length ? 'AUTHORITY_ERROR' : 'OK',
    artifact_id: artifactId,
    lifecycle,
    accepted_by: acceptedBy,
    replacement_artifact_id: replacementArtifactId,
    verifications,
    authority_errors: authorityErrors,
    provenance: acceptedEvents
      .filter((event) => event.provenance.length > 0)
      .map((event) => ({
        event_id: event.event_id,
        action: event.action,
        refs: event.provenance,
      })),
    events: acceptedEvents.map((event) => event.event_id),
    last_event_id: previousEventId,
    next_sequence: expectedSequence,
    duplicate_count: duplicateCount,
  };
}

function applyLifecycleEvent(state, event) {
  const output = {
    lifecycle: state.lifecycle,
    acceptedBy: state.acceptedBy,
    replacementArtifactId: state.replacementArtifactId,
    verifications: state.verifications,
    authorityErrors: state.authorityErrors,
  };

  switch (event.action) {
    case 'propose':
      if (output.lifecycle === 'UNKNOWN') output.lifecycle = 'PROPOSED';
      break;

    case 'observe':
      if (output.lifecycle === 'UNKNOWN') output.lifecycle = 'OBSERVED';
      break;

    case 'accept':
      if (event.authority !== 'author') {
        output.authorityErrors.push({
          event_id: event.event_id,
          code: 'ACCEPT_REQUIRES_AUTHOR',
        });
      } else {
        output.lifecycle = 'ACCEPTED';
        output.acceptedBy = event.actor;
      }
      break;

    case 'verify':
      if (event.authority === 'model') {
        output.authorityErrors.push({
          event_id: event.event_id,
          code: 'MODEL_CANNOT_SELF_VERIFY',
        });
      } else {
        output.verifications.push({
          event_id: event.event_id,
          authority: event.authority,
          actor: event.actor,
          provenance: event.provenance,
        });
      }
      break;

    case 'reject':
      if (event.authority !== 'author') {
        output.authorityErrors.push({
          event_id: event.event_id,
          code: 'REJECT_REQUIRES_AUTHOR',
        });
      } else {
        output.lifecycle = 'REJECTED';
      }
      break;

    case 'supersede':
      if (event.authority !== 'author') {
        output.authorityErrors.push({
          event_id: event.event_id,
          code: 'SUPERSEDE_REQUIRES_AUTHOR',
        });
      } else {
        output.lifecycle = 'SUPERSEDED';
        output.replacementArtifactId = event.replacement_artifact_id;
      }
      break;

    default:
      throw new MemoryEventError('INVALID_ACTION', `unsupported memory action: ${event.action}`);
  }

  return output;
}

function historyError(state, details) {
  return {
    state,
    lifecycle: 'UNKNOWN',
    accepted_events: [],
    duplicate_count: 0,
    details,
  };
}

async function listJsonFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

async function hashJournalFiles(files, eventRoot) {
  const hash = createHash('sha256');
  for (const file of files) {
    const relative = path.relative(eventRoot, file).split(path.sep).join('/');
    hash.update(relative, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(await readFile(file));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

async function atomicWrite(destination, content) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content);
  await rename(temporary, destination);
}

function assertSequence(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MemoryEventError('INVALID_SEQUENCE', 'sequence must be a positive safe integer');
  }
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new MemoryEventError('INVALID_ID', `${field} must match ${SAFE_ID_RE}`);
  }
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MemoryEventError('INVALID_FIELD', `${field} must be a non-empty string`);
  }
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortJson(value[key]);
  }
  return output;
}
