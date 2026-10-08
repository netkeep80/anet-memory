# Two-store cutover — durable outbox, sink freeze and receipt reconciliation

Status: **RESEARCH ONLY / SYNTHETIC EFFECTS ONLY**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)

## Why this experiment exists

The prior `fenced-effect-sink` experiment proved a local downstream property: if an effect sink atomically checks authenticated authority and idempotency at its own commit point, an old in-flight request is either before the authority rotation or rejected after it. It did **not** solve the next distributed gap: ANet's source journal and the downstream sink are independent durable stores and do not share one atomic transaction.

This experiment deliberately uses **two different SQLite databases** and never starts a transaction across both.

The source uses a durable outbox rule: an effect intent is committed before any request can be sent. The sink keeps its own effect receipts and authority state. Cutover is a fail-closed protocol:

`SOURCE ACTIVE → SOURCE_FENCED → SINK_FROZEN → RECONCILED → SUCCESSOR_ACTIVE → SOURCE PROMOTED`

The sink is the effect-eligibility authority. `SOURCE PROMOTED` is only a local observation after sink activation.

## Protocol

1. **Durable intent first.** Source appends `(effect_key,payload_sha256)` to an immutable hash-chained outbox before dispatch.
2. **Source fence.** The finite terminal outbox prefix is fixed; no new old-generation intents are allowed.
3. **Sink freeze barrier.** The downstream sink serializes all generation-1 effect commits against `SINK_FROZEN`. An old in-flight request either has a receipt before the freeze or is rejected afterwards.
4. **Receipt reconciliation.** Source compares every terminal outbox intent with the sink's exact frozen receipt set. Extra sink effects or payload mismatches fail closed. The reconciliation certificate binds source terminal head, sink freeze receipt, sink terminal effect head, applied keys and pending keys.
5. **Successor activation.** The sink stays effect-ineligible while frozen. It accepts generation 2 only with a source-authenticated reconciliation certificate and a control-authenticated activation request bound to the exact freeze hash.
6. **Source promotion observation.** The source may record `PROMOTED` only after directly verifying the sink's durable `SUCCESSOR_ACTIVATED` receipt (sequence, hash and reconciliation digest). The reconciliation digest alone is insufficient. This source flag does not authorize effects.
7. **Pending replay.** After sink activation, the successor may replay pending durable intents with the same global idempotency key. An already-applied key with the same payload resolves as `ALREADY_APPLIED`; conflicting payload fails closed.

No distributed atomic commit is claimed or required. A crash between stages leaves a recoverable fail-closed state: before sink freeze the old sink may still be active but the source has a finite fenced outbox; after sink freeze no writer is effect-eligible until activation; after sink activation the old source remains fenced even if the source has not yet observed promotion.

The design follows the standard transactional-outbox principle that the send intent must be committed locally before unreliable delivery and that duplicate delivery requires idempotent downstream handling. This experiment tightens that pattern specifically around writer cutover by adding a sink freeze barrier and exact receipt reconciliation.

## Adversarial tests

`node --test test/two-store-cutover.test.mjs` runs 17 Python tests covering:

- old effect committed but ACK lost before cutover → classified `applied`, never duplicated;
- old request delayed until after sink freeze → rejected, classified `pending`, then safely replayed by generation 2;
- successor effect attempt before activation → rejected because sink is frozen;
- source `PROMOTED` before a durable sink activation receipt → rejected;
- new source intent after source fence → rejected;
- sink receipt with no source intent → reconciliation fails `UNTRACKED_SINK_EFFECT`;
- same key but different payload → reconciliation fails;
- tampered source terminal hash-chain or frozen sink receipt index → reconciliation fails;
- tampered reconciliation certificate / wrong freeze binding → activation fails;
- idempotent reconciliation retry;
- real `SIGKILL` after source-fence commit, sink-freeze commit and successor-activation commit but before ACK;
- 8 independent apply-vs-freeze races; every run is reconcilable as either `applied` or `pending`;
- explicit `external_effects_allowed=false`.

## What is newly established

Conditioned on the model's authenticated private sink and exact direct reads of both local databases, **cross-store atomicity is not necessary for safe cutover** if:

- the source persists every effect intent before dispatch;
- source fencing fixes a finite old-generation intent prefix;
- the downstream sink can enter a durable no-writer `FROZEN` state;
- the frozen sink exposes an exact immutable terminal receipt prefix;
- activation of the successor is bound to a verified reconciliation certificate;
- effect idempotency keys remain globally stable across generations.

This removes one conceptual blocker: we do not need to pretend `source COMMIT` and `sink COMMIT` are one transaction. We need a protocol in which unsafe intermediate states are effect-ineligible.

## What remains unproved

- ChatGPT Library discovery may be temporarily incomplete; this model reads both DBs directly and exactly.
- No genuinely different sandbox receives or protects the writer/control/attestation credentials.
- GitHub still is not proven as a protected no-rewind production authority.
- An arbitrary real third-party API may not support `FROZEN`, global idempotency, authoritative receipt enumeration or generation fencing.
- The sink is local SQLite, not a remotely available durable service.
- A cloned source or sink DB (including copied credentials) can still create split-brain; this experiment assumes one non-cloned authority instance and does not overturn the two-writable-clones falsifier from #60.
- The source attestation key is a research fixture, not production identity.
- Synthetic receipt application is not a real-world side effect.
- #54 is not accepted and #52 must remain effect-disabled.

## Next #54 gate

Transport and authority: reproduce the same reconciliation contract when checkpoint/outbox/certificate material is moved through the real ChatGPT Library under incomplete discovery, with a trusted immutable selector for the exact terminal source head and sink freeze certificate. Separately, determine what concrete external systems can actually supply the required downstream idempotency/fencing contract rather than assuming it.
