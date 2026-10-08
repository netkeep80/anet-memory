import { createHash } from 'node:crypto';

/**
 * EXPERIMENTAL MODEL — NOT an external-effect executor.
 *
 * This in-process deterministic model assumes a downstream service provides
 * atomic, persistent, serialized installation of authority and effect writes.
 * Calling installAuthority does NOT verify a GitHub commit or authenticate
 * a caller. Its arguments are a simulated, already-verified authority feed.
 *
 * This explicitly cannot establish cross-process durability, authentication,
 * exactly-once delivery or safe effects on an arbitrary external system.
 */
export class ResearchEffectSink {
  #scopes = new Map();
  #effects = new Map();
  #history = [];

  installAuthority({ scope, generation, commit_sha: commitSha }) {
    checkScope(scope);
    checkGeneration(generation);
    checkCommit(commitSha);
    const previous = this.#scopes.get(scope);
    if (previous && generation < previous.generation) {
      return refusal('STALE_AUTHORITY', { current_generation: previous.generation });
    }
    if (previous && generation === previous.generation) {
      return previous.commit_sha === commitSha
        ? { state: 'AUTHORITY_ALREADY_INSTALLED', generation }
        : refusal('AUTHORITY_FORK', { current_commit_sha: previous.commit_sha });
    }
    this.#scopes.set(scope, Object.freeze({ generation, commit_sha: commitSha }));
    return { state: 'AUTHORITY_INSTALLED', generation };
  }

  /**
   * "apply" is only a simulated atomic downstream transaction.
   *
   * effect_key is unique across ALL generations within a scope. An old key
   * with a new payload is never silently rewritten, including after renewal.
   */
  apply({ scope, generation, commit_sha: commitSha, effect_key: effectKey, payload_bytes: payloadBytes }) {
    checkScope(scope);
    checkGeneration(generation);
    checkCommit(commitSha);
    checkEffectKey(effectKey);
    const bytes = toExactBytes(payloadBytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const current = this.#scopes.get(scope);
    if (!current) return refusal('NO_AUTHORITY');
    if (generation !== current.generation) {
      return refusal('STALE_OR_FUTURE_GENERATION', { current_generation: current.generation });
    }
    if (commitSha !== current.commit_sha) {
      return refusal('WRONG_COMMIT', { expected_commit_sha: current.commit_sha });
    }

    const key = JSON.stringify([scope, effectKey]);
    const existing = this.#effects.get(key);
    if (existing) {
      return existing.digest === digest && existing.commit_sha === commitSha && existing.generation === generation
        ? { state: 'ALREADY_APPLIED', receipt: existing.receipt }
        : refusal('IDEMPOTENCY_KEY_CONFLICT', { applied_digest: existing.digest });
    }

    const receipt = Object.freeze({
      scope,
      effect_key: effectKey,
      generation,
      commit_sha: commitSha,
      payload_sha256: digest,
    });
    this.#effects.set(key, Object.freeze({ digest, generation, commit_sha: commitSha, receipt }));
    this.#history.push(receipt);
    return { state: 'APPLIED', receipt };
  }

  /** Read only: may retrieve a prior receipt when a stale retry is rejected. */
  getReceipt(scope, effectKey) {
    checkScope(scope);
    checkEffectKey(effectKey);
    return this.#effects.get(JSON.stringify([scope, effectKey]))?.receipt ?? null;
  }

  get effectCount() { return this.#history.length; }
  get history() { return [...this.#history]; }
  getAuthority(scope) {
    checkScope(scope);
    const a = this.#scopes.get(scope);
    return a ? { ...a } : null;
  }
}

function refusal(state, detail = {}) {
  return { state, ...detail };
}
function checkScope(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError('invalid scope');
  }
}
function checkEffectKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value)) {
    throw new TypeError('invalid effect_key');
  }
}
function checkGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('generation must be positive safe integer');
}
function checkCommit(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new TypeError('invalid commit_sha');
}
function toExactBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError('payload_bytes must be Buffer/Uint8Array, never JSON object');
}
