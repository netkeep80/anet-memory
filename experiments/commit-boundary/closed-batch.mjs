import { inspectChannel, parseEnvelope, sha256Hex } from '../../src/sandbox-bus.mjs';

/**
 * EXPERIMENTAL, UNTRUSTED manifest completeness check.
 *
 * Returns BATCH_COMPLETE only relative to this exact, caller-supplied manifest.
 * Does NOT prove that the manifest is authoritative or that no competing
 * manifesto/message exists outside the currently observed Library subset.
 * Never use BATCH_COMPLETE alone to authorize an irreversible side effect.
 */
export function inspectClosedBatch(manifest, discoveredObjects) {
  const invalid = validateManifest(manifest);
  if (invalid !== null) {
    return { state: 'INVALID_MANIFEST', reason: invalid, effect_allowed: false };
  }
  if (!(discoveredObjects instanceof Map)) {
    return { state: 'INVALID_INPUT', reason: 'discoveredObjects must be a Map of path to exact bytes', effect_allowed: false };
  }

  const observed = [];
  const missing = [];

  for (const entry of manifest.entries) {
    const bytes = discoveredObjects.get(entry.path);
    if (bytes === undefined) {
      missing.push(entry.path);
      continue;
    }
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      return { state: 'INVALID_OBJECT', reason: 'bytes_required', path: entry.path, effect_allowed: false };
    }
    if (bytes.byteLength !== entry.size_bytes) {
      return { state: 'INVALID_OBJECT', reason: 'size_mismatch', path: entry.path, effect_allowed: false };
    }
    if (sha256Hex(bytes) !== entry.sha256) {
      return { state: 'INVALID_OBJECT', reason: 'sha256_mismatch', path: entry.path, effect_allowed: false };
    }

    let envelope;
    try {
      envelope = parseEnvelope(Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      return { state: 'INVALID_OBJECT', reason: error.code ?? 'parse_failed', path: entry.path, effect_allowed: false };
    }
    if (
      envelope.source !== manifest.source ||
      envelope.target !== manifest.target ||
      envelope.message_id !== entry.message_id ||
      envelope.sequence !== entry.sequence
    ) {
      return { state: 'INVALID_OBJECT', reason: 'identity_mismatch', path: entry.path, effect_allowed: false };
    }
    observed.push(envelope);
  }

  const channel = inspectChannel(observed, { source: manifest.source, target: manifest.target });
  if (channel.state === 'CHANNEL_FORK' || channel.state === 'MESSAGE_ID_CONFLICT' || channel.state === 'INVALID_MESSAGE') {
    return { state: channel.state, verified: observed.length, expected: manifest.entries.length, effect_allowed: false };
  }
  if (missing.length > 0) {
    return {
      state: 'MISSING_DEPENDENCY',
      missing,
      verified: observed.length,
      expected: manifest.entries.length,
      observed_channel_state: channel.state,
      effect_allowed: false,
    };
  }
  if (channel.state !== 'OK' || channel.accepted.length !== manifest.entries.length) {
    return {
      state: 'INVALID_CHAIN',
      reason: channel.state,
      verified: observed.length,
      expected: manifest.entries.length,
      effect_allowed: false,
    };
  }

  return {
    state: 'BATCH_COMPLETE',
    verified: observed.length,
    expected: manifest.entries.length,
    channel_next_sequence: channel.next_sequence,
    effect_allowed: false,
    authority: 'UNVERIFIED',
  };
}

export function inspectCompetingManifests(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) {
    return { state: 'NO_MANIFEST', effect_allowed: false };
  }
  const seen = new Map();
  for (const manifest of manifests) {
    const invalid = validateManifest(manifest);
    if (invalid) return { state: 'INVALID_MANIFEST', reason: invalid, effect_allowed: false };
    const key = JSON.stringify([manifest.run_id, manifest.epoch, manifest.source, manifest.target]);
    const normalized = JSON.stringify({
      object_count: manifest.object_count,
      entries: [...manifest.entries].sort((a, b) => a.path.localeCompare(b.path)),
    });
    const prior = seen.get(key);
    if (prior !== undefined && prior !== normalized) {
      return { state: 'COMPETING_MANIFESTS', run_id: manifest.run_id, epoch: manifest.epoch, effect_allowed: false };
    }
    seen.set(key, normalized);
  }
  // This only means no conflict among manifests actually supplied.
  return { state: 'NO_OBSERVED_CONFLICT', observed_manifests: manifests.length, effect_allowed: false };
}

function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'expected_object';
  if (m.protocol !== 'anet-closed-batch/research-1') return 'protocol';
  for (const key of ['run_id', 'epoch', 'source', 'target']) {
    if (typeof m[key] !== 'string' || m[key].length === 0) return 'missing_' + key;
  }
  if (!Array.isArray(m.entries) || m.entries.length === 0) return 'entries';
  if (!Number.isSafeInteger(m.object_count) || m.object_count !== m.entries.length) return 'object_count';

  const paths = new Set();
  const logical = new Set();
  for (const e of m.entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return 'entry_object';
    if (
      typeof e.path !== 'string' ||
      !/^messages\/[A-Za-z0-9_.:-]+\.json$/.test(e.path) ||
      e.path.includes('..')
    ) return 'unsafe_path';
    if (paths.has(e.path)) return 'duplicate_path';
    paths.add(e.path);
    if (typeof e.message_id !== 'string' || !e.message_id) return 'message_id';
    if (!Number.isSafeInteger(e.sequence) || e.sequence < 1) return 'sequence';
    const id = String(e.sequence) + ':' + e.message_id;
    if (logical.has(id)) return 'duplicate_logical_id';
    logical.add(id);
    if (!Number.isSafeInteger(e.size_bytes) || e.size_bytes < 0) return 'size_bytes';
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return 'sha256';
  }
  return null;
}
