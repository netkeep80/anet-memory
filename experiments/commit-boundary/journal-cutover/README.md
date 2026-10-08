# Checkpoint → hash-chained journal → isolated SQLite receipt catch-up

Status: **RESEARCH / ZERO EXTERNAL SIDE EFFECTS**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
Source baseline: `26bfe9e7ef3f8069e86a5d9ca6491b7c1932c1f6`  
Date: 2026-10-08.

## Concrete question

The [portable SQLite snapshot](../sqlite-portable/README.md) preserves the exact state **at a point in time**, but an old executor can still commit events afterward. A new executor replaying only the snapshot misses those events; independent DB clones can also accept the same new idempotency key. A message channel that merely lists visible Library files is not a complete journal.

This experiment tests **deterministic, fail-closed receipt catch-up conditional on an already known exact terminal hash**, not global uniqueness or external authority. It does not change the accepted `sandbox-bus/1` protocol.

## Explicit data model

`cutover_journal.py` defines `anet-checkpoint-journal/research-1` containing:

- `scope,generation,commit_sha` — **supplied claims, not authenticated authority**;
- checkpoint `base_sequence,base_head_hash,base_count,base_effects_sha256`;
- contiguous `entries[]` with sequence, scoped idempotency key, synthetic payload SHA-256, previous entry hash and canonical entry SHA-256;
- terminal `target_sequence,target_head_hash,entries_sha256`;
- **`authority_authenticated:false` and `external_effects_allowed:false`**.

Every digest is computed over canonical JSON with sorted keys, UTF-8 and no whitespace. No semantic MTS payload is interpreted. An entry is only a **candidate receipt**; it is not cryptographic evidence that a remote service performed the effect. An untrusted actor can manufacture an internally consistent chain and a matching terminal hash. Thus, a true remote authority must independently pin and authenticate the journal's terminal commitment before a consumer uses it for any meaningful action.

### Validation and local atomic import

`verify_batch` checks strict fields, chain ancestry, contiguous sequence, no duplicate effect keys, SHA-256, explicit terminal hash and the untrusted/zero-effects flags. Missing or reordered events, divergent hashes and forged commit claims fail closed.

`replay` adds a dedicated research `research_cutover_state` table. Inside `BEGIN IMMEDIATE` it checks that the *actual SQLite database* equals the declared checkpoint's effect digest/count/generation/commit. All journal receipts are inserted in **one SQLite transaction**; the counter and terminal digest/head are committed atomically. A retry after the commit may return `ALREADY_REPLAYED` only when the recorded head, final row digest, count, and each receipt are still identical. Any conflicting cut or stale state fails closed. No external HTTP, GitHub, Library or application operation is issued by this code.

This local transaction serializes writes **within one SQLite file only**. It cannot stop another independent copy of that file from accepting the same receipts. A valid, complete and SHA-verified chain still proves no global uniqueness without a protected authority selecting it.

## Adversarial tests

`test_cutover_journal.py` is executed by `test/journal-cutover.test.mjs` under CI. Test matrix:

- valid journal remains `JOURNAL_VERIFIED_UNAUTHENTICATED`, not `COMMITTED`;
- two receipts import once, with same-batch retry deduplicated;
- tampered bytes/entry digest, missing middle event, reversed order, bad predecessor and alternative terminal anchor rejected;
- same key twice in journal or collision with checkpoint effect rejected atomically;
- checkpoint drift after journal formation, wrong generation, or competing post-commit terminal rejected;
- `authority_authenticated:true`/`external_effects_allowed:true` rejected;
- a **real child subprocess SIGKILL** immediately before COMMIT causes full rollback; retry imports;
- real SIGKILL after COMMIT but before response preserves receipts; retry is `ALREADY_REPLAYED`;
- **two separate SQLite clones** each accept the same valid journal independently — an intentionally passing *negative* proof of non-global idempotence.

Test command (Linux with Python 3 stdlib sqlite3 and Node):

```bash
node --test test/journal-cutover.test.mjs
```

No Library objects or Git refs are mutated by these CI tests, and no active #26/#52 experiment is touched.

## Trust and cutover barriers still missing

A *candidate* safe succession sequence, not yet an accepted production protocol:

1. An authenticated **single writer/fencing authority** stops or rejects old-worker commits at a well-defined cutover generation. The receiving effect sink must independently verify fencing, not trust a caller's generation string.
2. An immutable checkpoint is taken using SQLite Backup API and hashed. Its journal cursor and DB row digest are anchored by an immutable selection record.
3. All journal events after that cursor are published as exact bytes. The trusted authority commits a **specific target sequence and terminal hash**, not "whatever files Library currently shows".
4. A successor in a new sandbox independently discovers and verifies the checkpoint plus **every** required journal item. Absent/delayed items => `GAP_PENDING`, never empty history.
5. Transactional receipt catch-up is performed against a **single shared authoritative effect sink** or a fenced *inactive* successor state. Only afterward may verified authority promote the successor, and then only for actions supported by the downstream system's own idempotency and fence.
6. Crash between an outside transaction and an ACK requires independent recovery; a local replay log alone cannot exactly-once an arbitrary non-idempotent external API.

### Unproven blockers (remain OPEN in #54)

- GitHub commit/ref governance: branch protection/authorized writers/no-force not independently verified, and competing-ref loser calls have ambiguous GraphQL errors;
- fresh-chat Library readbacks (#7 original corpus, #54 selected manifest and SQLite checkpoint) remain PENDING;
- synchronizing a globally authoritative cut, avoiding a race between checkpoint creation and late writes;
- durable journal replication/ordering across distinct sandboxes with a trustworthy terminal commitment;
- authenticated downstream idempotency/fencing and actual external effects.

**Classification:** this is a deterministic, local, fail-closed **journal-catch-up research prototype**. Do not call it globally committed, distributed exactly once, or production-safe merely because tests pass.
