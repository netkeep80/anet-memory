# Application effect replay and fencing — controlled model

Status: **RESEARCH MODEL; NOT AN EXTERNAL TRANSACTIONAL SERVICE**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54). Pinned starting `main`: `56d8e7e6dab2dbcfac26262ad2f0a54f0c029b89`.

This is an **untrusted simulation** of the downstream side-effect boundary. Unlike `closed-batch.mjs`, it models what the receiving **application** would need before externally visible side effects are safe. It does not change accepted `sandbox-bus/1`, A-memory, FORMAL or a live Library namespace.

## Required independently verified chain

```
Library exact-byte validated message
    -> BATCH_COMPLETE (only relative to manifest; not authority)
    -> verified GitHub selection / trusted authority policy
    -> downstream atomic transaction:
         check monotonic generation, scope, commit identity,
         globally unique effect key + exact payload digest,
         apply operation and persist receipt atomically
    -> ACK may be emitted or lost
    -> on retry: lookup stable receipt, no repeated effect
```

Three mechanisms must **not** be conflated:
1. Library transport can duplicate or delay listing and uploads; path collision auto-renames.
2. GitHub ref commit history may identify selected bytes, but authentication/branch permissions, no-force monotonicity, and concurrent ref-update semantics remain unaccepted.
3. Side effects in a third-party system require that system's own **atomic** deduplication/fencing semantics or an explicitly tolerated at-least-once/saga policy. Publishing an ACK to Library is not the application transaction.

## Code and explicit trust limitations

`simulated-effect-sink.mjs` is a synchronous in-memory state machine with simulated externally retained state:

- `installAuthority(scope,generation,commit_sha)`: injects an **already-verified** authority snapshot. It does **not** verify GitHub or authenticate a caller. Out-of-order/older generations refuse to replace newer authority, same generation with different commit => `AUTHORITY_FORK`. The API is **unsafe** if exposed to an untrusted caller directly.
- `apply(scope,generation,commit_sha,effect_key,payload_bytes)`: rejects missing/stale/future generation and wrong commit; applies each unique effect key once within a scope; exact replays are `ALREADY_APPLIED`; divergent re-use is `IDEMPOTENCY_KEY_CONFLICT`.
- `getReceipt`: read-only recovery path after lost ACK. It is not application authorization.
- All inputs use exact bytes; a `file_id`, `library_file_id`, filename, timestamp, model assertion or idempotency key by itself proves no authority.

The synchronous Map-based implementation only approximates the behavior of a *single serialized durable transaction*. It does NOT prove any of the following: cross-process concurrent correctness, external DB guarantees, persistence through real process kill, security from forged authority, durability after power loss, or exactly-once arbitrary HTTP API effects.

## Falsifiers (test/effect-replay-fencing.test.mjs)

1. No installed authority ⇒ `NO_AUTHORITY`.
2. Simulated authority installation + valid effect applies once.
3. ACK lost **after** sink transaction, retry same exact payload/key → `ALREADY_APPLIED`, one stored receipt.
4. Crash **before** sink transaction, retry → one application.
5. Same key with differing bytes ⇒ `IDEMPOTENCY_KEY_CONFLICT`.
6. Future/stale generation or wrong commit ⇒ rejected.
7. New generation installed, old worker attempts new action ⇒ rejected.
8. ABA-like older generation replay ⇒ rejected by monotonic high-water mark.
9. Same generation with different commit ⇒ `AUTHORITY_FORK`.
10. Historical idempotency key cannot be reassigned under new generation.
11. After renewal, stale retry fails; prior receipt remains readable without reapplication.
12. Distinct scopes/keys remain independent.
13. JS Promise batching delivers one model effect; **not evidence of multi-process atomicity**.
14. Type/ID/generation validation fails closed.
15. Negative security proof: if a caller can directly invoke `installAuthority` with a forged higher generation, it can authorize itself. **A real service must authenticate verified authority from a trusted channel**, not accept these values from an agent.

```bash
npm test
```

## Required next research: real durable effects and crash behavior

A separate project-owned experiment must select a *real* downstream transactional sink (e.g. SQLite unique constraint + a monotonic generation register updated within a transaction, under a single-writer durable volume; or a provider that supports idempotency keys and fencing). Test real subprocess `SIGKILL` after COMMIT but before publishing ACK, restart from preserved durable backend, replay, and verify exactly one application with an independent audit query.

Explicitly distinguish:
- crash before DB commit;
- crash after DB commit, before ACK;
- ACK publication failed or delayed in Library;
- newer authority generation accepted before older worker finishes;
- two independent workers attempt same/different payload with same key;
- an external irreversible side effect performed **outside** the transaction, which can create an unrecoverable duplicate risk and must NOT be called exactly-once.

Until these falsifiers are run in an actual durable sink with genuinely independent producers, `#54` stays open. This model is useful for specifying semantics, not for certifying production safety.

## GitHub authority governance control

Read-only REST audit on 2026-10-08:
- `GET /repos/netkeep80/anet-memory/rulesets` returned `[]`.
- Branch protection endpoints for `main` and research refs returned **403 Resource not accessible by integration**.

This does **not** conclusively prove absence of any branch protection, and certainly does not prove an active no-rewind/no-force guarantee. The missing authoritative permission evidence remains a blocker for promoting GitHub ref to a **trusted** linearization authority. Treat generic GraphQL errors on losing ref updates as uncertain until bounded and independently validated.
