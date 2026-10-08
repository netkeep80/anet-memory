# Authenticated downstream effect cutover — research model

Status: **RESEARCH ONLY / SYNTHETIC EFFECTS ONLY**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)

## Question

The source-side cutover model proves that a shared authority can serialize an old journal append against a fence. It does **not** cover a request that already left the old writer before the fence but reaches the downstream service after authority changed.

This experiment asks a narrower question: **if the downstream commit point itself atomically authenticates the writer, checks the current generation/commit, and deduplicates the logical effect key, can an in-flight old request execute after cutover?**

The answer in this local SQLite model is **no**. `apply()` and `rotate()` take the same `BEGIN IMMEDIATE` transaction. A request signed under generation 1 racing generation 1→2 rotation has exactly two safe outcomes:

1. `apply()` commits first — the synthetic effect receipt belongs to generation 1 and is durable before rotation.
2. `rotate()` commits first — the stale request is refused and cannot create a receipt afterward.

A captured valid old request delivered only after rotation is rejected. A caller merely claiming a generation without the generation credential is rejected. Effect keys are unique across all generations within a scope, so generation renewal cannot replay an already applied logical effect under the same key.

## Authentication model

For this research harness only, each installed generation has a random/opaque shared HMAC secret. The request signature binds exact `scope`, `generation`, `commit_sha`, `effect_key`, and `payload_sha256`. Rotation atomically replaces generation, commit and secret. This demonstrates *possession-based request authentication inside the sink model*; it does **not** establish how a production secret is provisioned, protected, revoked, attested, or shared across ChatGPT sandboxes.

## Crash/race evidence

The 13-test suite includes:

- valid writer and forged-writer cases;
- captured old request delivered after rotation;
- generation-2 request requiring the new credential;
- idempotent retry and cross-generation effect-key conflict;
- stale controller CAS rejection;
- direct apply-vs-rotate race plus 8 isolated **real subprocess** races;
- real `SIGKILL` immediately before/after synthetic effect COMMIT;
- real `SIGKILL` immediately before/after authority-rotation COMMIT.

All "effects" are only rows plus a counter in the same SQLite DB. Therefore atomicity is real for the model but says nothing about an arbitrary HTTP API whose irreversible side effect and our SQLite receipt live in separate transaction domains.

## Safety conclusion

**Source-side fencing alone is insufficient.** For an irreversible effect to inherit cutover safety, the effect system itself must expose a durable commit point that can atomically enforce:

`authenticated current authority ∧ monotonic generation ∧ idempotency key ∧ effect commit`.

If an external service cannot provide an equivalent primitive, a request already sent before cutover remains an unresolved ambiguity window. ANet Memory must fail closed rather than infer safety from a local receipt, ACK, Git commit, Library object, or generation number.

## Non-claims / remaining blockers

This does **not** prove:

- cross-sandbox/shared production authority;
- no-rewind GitHub ref protection or sole-writer governance;
- secure credential distribution/revocation;
- exactly-once execution on arbitrary external services;
- fresh-chat Library completeness or terminal-selector discovery;
- correctness of accepted `sandbox-bus/1`, #26 endurance, or #52 supervisor.

External irreversible effects remain forbidden. Next research should separate services into those with a transactional/idempotent authority gate and those without one, then define the protocol/compensation requirements for the latter.
