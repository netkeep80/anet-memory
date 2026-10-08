# Portable SQLite effect-sink snapshot through ChatGPT Library

Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
Research run: `sqlite-portable-20261008-01` (2026-10-08)  
Previous local crash evidence: [sqlite-crash](../sqlite-crash/README.md), run `sqlite-crash-20261008-01`  
Status: **SAME-SANDBOX ROUND-TRIP PASS; DIFFERENT-SANDBOX/FRESH CHAT PENDING**

This experiment answers a narrow question: can a local SQLite/WAL transactional effect-sink state be converted into a single, SHA-verified Library artifact and reconstructed in a *new empty working directory*, preserving previously recorded idempotency keys and monotonic generation? It does **not** prove that ChatGPT Library is a transactionally synchronized database, that a snapshot includes effects executed later, or that GitHub authority grants are authenticated.

## Immutable source evidence

Both baseline Python scripts were read from ChatGPT Library (created by #54 run `sqlite-crash-20261008-01`), then independently compared against the exact GitHub SHA-1 blob and source SHA-256 from accepted `main=0a4b4e0872ccf3152d7dd52c7c9e8c82dd951aa6`:

| Source | Bytes | SHA-256 | Git blob SHA-1 |
|---|---:|---|---|
| `../sqlite-crash/sqlite_effect_sink.py` | 4230 | `eae221cd62a8241d0ef73d03f2e4a716754d780bf3ee27e0de7a5c3e4a90ff6b` | `3822f334752f10c2744d241fefe6d402b32aaa21` |
| `../sqlite-crash/run_probe.py` | 3646 | `80b76db0324e68ce0b1d9ea121ed8b9a9aab82596d7be3746acdc5136eb090c7` | `c59a7f30e7743fe22645abcff622943981251d72` |
| `../sqlite-crash/result.json` | 841 | `a12f42cfd05bfe7c8aeafe689329d0add244197745bf07892c0487d3aa429c2d` | `970f85501bf22478cce295816f971bc8f7b4c330` |

New export verifier `portable_snapshot.py`: 4,337 exact UTF-8 bytes, SHA-256 `7c1ccf3c48f8a72ce591cedead8662c7b53067dfd5b104fa35ab81030276db19`. It checks `PRAGMA integrity_check`, scoped authority/effects/counter equality, exact source vs backup row-digests, serializes a manifest with file SHA-256, and always reports `authority=UNVERIFIED`/`external_effects_allowed=false`. No production imports.

## Producer-local failure injection and acceptance

Host `5efcb0801173`, Python sqlite3 `3.46.1`. A new scratch `producer/` reproduced the previous eight-process/SIGKILL experiment, returning 4 effects / generation 2. A SQLite WAL connection was **kept open**, followed by an additional committed effect with key `portable-proof`; source database now contained **5** effects, counter 5, generation 2 and a 12,392-byte WAL.

**Unsafe control:** direct copy of `run-54-sqlite.db` while WAL remained active created a valid-looking SQLite DB but exposed **only 4** effects / counter 4. SQLite integrity check was `ok` on that stale copy. This shows a valid SQLite header/integrity check is insufficient to guarantee all committed effects were transported.

**Safe control:** `sqlite3.Connection.backup` to a new standalone SQLite file captured all 5 effects. `PRAGMA integrity_check=ok`; the canonical sorted effect list SHA-256 was:

`820feef4f6161561310582c0c52fa276421315a1c45d734fd1d3b2271c6dd39b`

| Export artifact | Bytes | SHA-256 |
|---|---:|---|
| `portable-snapshot.sqlite` | 28,672 | `cc5d5fb13798ecb5c7d55883e07e246d517bf007fbc88266a81ad9c3150cba44` |
| `portable-snapshot.manifest.json` | 816 | `1fc1afde012ebbc97d02463adecf53318e66d8daf2cb66dd2cdb0beafecf53c5` |
| `result.json` | 2,130 | `3ed88d2e39d1724665d1778da0099ce9ff2559f238f5386c84ee3cb4044b6bd8` |
| `portable_snapshot.py` | 4,337 | `7c1ccf3c48f8a72ce591cedead8662c7b53067dfd5b104fa35ab81030276db19` |

`result.json` was sealed **before Library upload**: its field `library_upload=PENDING` is a historical state at evidence creation, **not** current acceptance evidence. Library upload outcomes below were verified afterward. Do not overwrite old evidence to hide this chronology.

## Actual Library publisher and same-chat readback

Unique isolated Library namespace:

```text
/anet-memory/experiments/commit-boundary/sqlite-portable-20261008-01/
    portable-snapshot.sqlite
    portable-snapshot.manifest.json
    result.json
    portable_snapshot.py
```

One `files.manage_library` call containing four `upload(container_path,overwrite=false)` operations: 2026-10-08 **10:14:25–10:14:36 UTC**, four `status=succeeded`, all exact actual returned paths.

| Object | Verified Library file_id |
|---|---|
| `portable-snapshot.sqlite` | `file_00000000e3488246936ab95b1cee7a6c` |
| `portable-snapshot.manifest.json` | `file_00000000d93881f4bce9acd074990749` |
| `result.json` | `file_00000000b4508208961787e9f1c41d1b` |
| `portable_snapshot.py` | `file_00000000aff881f4b22fd86e3ae1cbe9` |

First separate directory listing at 10:14:41 UTC reported all four. `files.materialize` read back all four into a **separate local directory**. Exact SHA-256 and `cmp` original-vs-Library PASS for **all 4**.

After verifying snapshot bytes and manifest SHA independently, a brand-new local `consumer-Library-readback/` folder was created. ONLY the readback SQLite snapshot was copied into it (the sink code was the GitHub-blob-verified source). The consumer simulation executed independent Python CLI subprocesses against that restored DB:

- before replay: 5 effects, counter 5, generation 2;
- exact retry of `portable-proof`: `ALREADY_APPLIED`, counter stays 5;
- changed payload same key: `IDEMPOTENCY_KEY_CONFLICT`;
- previous authority generation 1: `STALE_AUTHORITY`;
- new generation 3 installed: `AUTHORITY_INSTALLED`;
- stale generation 2 new effect: `STALE_OR_FUTURE_GENERATION`;
- fresh generation 3 new effect: `APPLIED`, resulting in 6 effects/counter 6.

A single modified backup byte was rejected **by SHA-256 before opening the database**. The standalone Node CI test `test/sqlite-portable-snapshot.test.mjs` independently proves the 1→2 active-WAL backup vs stale direct copy in a smaller fixture and the tamper rejection.

**Classification:** `PASS_SAME_SANDBOX_SQLITE_PORTABLE_SNAPSHOT`, not `PASS_CROSS_SANDBOX`.

## Necessary correctness boundary

The snapshot is **point-in-time**. A new worker cannot infer whether an old or competing worker committed effects after this snapshot. Restoring an old snapshot and then repeating an external effect may cause duplicate execution unless that target has its own idempotence/fencing authority.

A strict recovery protocol must also validate:
1. exact bytes + SHA-256 of all manifest-referenced objects;
2. *current authoritative checkpoint/head* with monotonic generation and a trusted no-rewind policy (GitHub candidate in #54, still NOT accepted);
3. a quiescence/freeze or journal catch-up barrier covering changes after the backup cut;
4. no unilateral authority upgrade by the recovering worker;
5. checkpoint selection must not rely on Library filename uniqueness, search completeness, or time delays alone.

The manifest explicitly states `authority_verification=NOT_PROVEN` and `external_effects_allowed=false`. A consumer may report `SNAPSHOT_VERIFIED`, but NEVER `COMMITTED_GLOBAL_AUTHORITY` from this artifact.

## Independent fresh consumer — pending

See [CONSUMER.md](CONSUMER.md). A truly new chat must independently verify the GitHub sources and pinned hashes, discover the exact Library objects, read/mount the exact bytes into its own new sandbox, verify SQLite integrity and scoped row-digest, and retry a known idempotency key without reapplying the effect. It must not use transcript/semantic handoff or prior local producer files.

No edits to active endurance #26 or scheduled supervisor #52.

## Additional adversarial check: a checkpoint does not globally deduplicate subsequent effects

After the original snapshot had been finalized and uploaded, its producer SQLite file and a new writable clone of its exact Library-readback SQLite file independently received the same *new* synthetic effect key `after-snapshot` under generation 2. Both returned `APPLIED` and each local counter advanced from 5 to 6. The old checkpoint was byte-perfect and internally consistent; the two databases were simply not sharing a durable atomic uniqueness index. **No external effect was executed.**

This is the expected but important **POST_SNAPSHOT_DIVERGENT_EFFECT_ACCEPTANCE_OBSERVED** counterexample; issue [#54 comment 6057752261](https://github.com/netkeep80/anet-memory/issues/54#issuecomment-6057752261). The CI regression in `test/sqlite-portable-snapshot.test.mjs` independently demonstrates the same property with two databases derived from one snapshot. **Passing this negative test must never be described as global exactly-once safety.** A verified snapshot is only an integrity-preserving transfer of a point-in-time state; safe cutover still requires a trusted writer fence, checkpoint selection, replay catch-up or shared transactional authority.
