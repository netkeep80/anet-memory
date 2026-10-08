import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchEffectSink } from '../experiments/commit-boundary/simulated-effect-sink.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const SCOPE = 'run-54';
const bytes = (value) => Buffer.from(value, 'utf8');
const effect = (overrides = {}) => ({
  scope: SCOPE, generation: 1, commit_sha: A,
  effect_key: 'message-1/action-1', payload_bytes: bytes('same exact bytes'),
  ...overrides,
});

test('missing trusted authority means no effect', () => {
  const sink = new ResearchEffectSink();
  assert.equal(sink.apply(effect()).state, 'NO_AUTHORITY');
  assert.equal(sink.effectCount, 0);
});

test('first eligible effect is applied once after simulated authority installation', () => {
  const sink = new ResearchEffectSink();
  assert.equal(sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A }).state, 'AUTHORITY_INSTALLED');
  const result = sink.apply(effect());
  assert.equal(result.state, 'APPLIED');
  assert.equal(sink.effectCount, 1);
  assert.equal(result.receipt.payload_sha256.length, 64);
});

test('crash AFTER downstream transaction but BEFORE ACK: retry is deduplicated', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  function senderThatLosesAck() {
    const result = sink.apply(effect());
    assert.equal(result.state, 'APPLIED');
    // The consumer loses the successful response; sink survives as an external service.
    throw new Error('SIMULATED_ACK_LOSS_AFTER_COMMIT');
  }
  assert.throws(senderThatLosesAck, /SIMULATED_ACK_LOSS/);
  assert.equal(sink.effectCount, 1);
  const replay = sink.apply(effect());
  assert.equal(replay.state, 'ALREADY_APPLIED');
  assert.equal(sink.effectCount, 1);
  assert.deepEqual(replay.receipt, sink.getReceipt(SCOPE, 'message-1/action-1'));
});

test('crash BEFORE downstream commit: later delivery applies exactly once', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  assert.equal(sink.effectCount, 0);
  // No commit was made: a request was prepared but delivery was interrupted.
  const recovered = sink.apply(effect());
  assert.equal(recovered.state, 'APPLIED');
  assert.equal(sink.effectCount, 1);
});

test('same key, changed payload => hard conflict, never reinterpret as duplicate ACK', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  assert.equal(sink.apply(effect()).state, 'APPLIED');
  const changed = sink.apply(effect({ payload_bytes: bytes('different bytes') }));
  assert.equal(changed.state, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(sink.effectCount, 1);
});

test('unknown generation and wrong authority commit cannot apply', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  assert.equal(sink.apply(effect({ generation: 2 })).state, 'STALE_OR_FUTURE_GENERATION');
  assert.equal(sink.apply(effect({ commit_sha: B })).state, 'WRONG_COMMIT');
  assert.equal(sink.effectCount, 0);
});

test('stale worker cannot apply after a newer generation is installed', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  sink.installAuthority({ scope: SCOPE, generation: 2, commit_sha: B });
  assert.equal(sink.apply(effect({ effect_key: 'stale-new-effect' })).state, 'STALE_OR_FUTURE_GENERATION');
  assert.equal(sink.apply(effect({ generation: 2, commit_sha: B, effect_key: 'current-effect' })).state, 'APPLIED');
  assert.equal(sink.effectCount, 1);
});

test('generation never rewinds, even if an older commit or payload becomes visible again (ABA)', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  sink.installAuthority({ scope: SCOPE, generation: 2, commit_sha: B });
  assert.equal(sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A }).state, 'STALE_AUTHORITY');
  assert.deepEqual(sink.getAuthority(SCOPE), { generation: 2, commit_sha: B });
  assert.equal(sink.effectCount, 0);
});

test('two conflicting commits at same generation do not silently overwrite authority', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  assert.equal(sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: B }).state, 'AUTHORITY_FORK');
  assert.equal(sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A }).state, 'AUTHORITY_ALREADY_INSTALLED');
  assert.equal(sink.getAuthority(SCOPE).commit_sha, A);
});

test('same effect key across NEW generation cannot be reused to change historical bytes', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  sink.apply(effect());
  sink.installAuthority({ scope: SCOPE, generation: 2, commit_sha: B });
  const attemptedRewrite = sink.apply(effect({
    generation: 2, commit_sha: B, payload_bytes: bytes('now changed'),
  }));
  assert.equal(attemptedRewrite.state, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(sink.effectCount, 1);
});

test('old receipt can be inspected read-only while stale worker replay is rejected', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  sink.apply(effect());
  const receipt = sink.getReceipt(SCOPE, 'message-1/action-1');
  sink.installAuthority({ scope: SCOPE, generation: 2, commit_sha: B });
  assert.equal(sink.apply(effect()).state, 'STALE_OR_FUTURE_GENERATION');
  assert.deepEqual(sink.getReceipt(SCOPE, 'message-1/action-1'), receipt);
  assert.equal(sink.effectCount, 1);
});

test('scope isolation and independent message idempotency keys', () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  sink.installAuthority({ scope: 'other-run', generation: 1, commit_sha: B });
  assert.equal(sink.apply(effect()).state, 'APPLIED');
  assert.equal(sink.apply(effect({ scope: 'other-run', commit_sha: B })).state, 'APPLIED');
  assert.equal(sink.apply(effect({ effect_key: 'message-2/action-1' })).state, 'APPLIED');
  assert.equal(sink.effectCount, 3);
});

test('independent delivery promises in one JS process produce one model effect, not proof of distributed atomicity', async () => {
  const sink = new ResearchEffectSink();
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => Promise.resolve().then(() => sink.apply(effect()))),
  );
  assert.equal(responses.filter((r) => r.state === 'APPLIED').length, 1);
  assert.equal(responses.filter((r) => r.state === 'ALREADY_APPLIED').length, 11);
  assert.equal(sink.effectCount, 1);
});

test('strict bytes, IDs, generation and commit validation; no implicit JSON semantics', () => {
  const sink = new ResearchEffectSink();
  assert.throws(() => sink.installAuthority({ scope: SCOPE, generation: 0, commit_sha: A }), /generation/);
  assert.throws(() => sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: 'not-a-commit' }), /commit_sha/);
  sink.installAuthority({ scope: SCOPE, generation: 1, commit_sha: A });
  assert.throws(() => sink.apply(effect({ payload_bytes: { a: 1 } })), /payload_bytes/);
  assert.throws(() => sink.apply(effect({ effect_key: '../unsafe' })), /effect_key/);
  assert.equal(sink.effectCount, 0);
});

test('caller-supplied authority is not authentication: explicit counterexample', () => {
  const sink = new ResearchEffectSink();
  // A malicious caller could install B if the real downstream exposed this
  // method without an independently authenticated/verified authority feed.
  assert.equal(sink.installAuthority({ scope: SCOPE, generation: 9, commit_sha: B }).state, 'AUTHORITY_INSTALLED');
  assert.equal(sink.apply(effect({ generation: 9, commit_sha: B })).state, 'APPLIED');
  // This demonstrates why the model alone CANNOT be used as a secure service.
  assert.equal(sink.effectCount, 1);
});
