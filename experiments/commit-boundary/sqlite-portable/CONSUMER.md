# Fresh-chat consumer — SQLite transactional sink portability

Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
RUN_ID: `sqlite-portable-20261008-01`  
Producer accepted source baseline: `0a4b4e0872ccf3152d7dd52c7c9e8c82dd951aa6`  
Research artifacts: [README.md](README.md)

**Mandatory isolation:** perform ONLY in a genuinely new ChatGPT conversation using a new empty local consumer directory. No semantic handoff, transcript replay, producer-local files, or trusted messages containing the missing nonce/payload. The user need only provide this runbook link and RUN_ID. Do not touch #26/#52, do not overwrite Library objects, do not pretend a new directory in this same chat is a fresh consumer.

## Procedure

1. Independently read this runbook, [README.md](README.md), [portable_snapshot.py](portable_snapshot.py) and the previous [SQLite sink](../sqlite-crash/sqlite_effect_sink.py) from GitHub at the pinned accepted source or later immutable **pinned revision**. Independently compute and compare source SHA-256 and Git blob SHA-1 against the README before executing. Record live GitHub `main` separately without accepting drift silently.
2. List this **exact Library folder**, not fuzzy search:

```text
/anet-memory/experiments/commit-boundary/sqlite-portable-20261008-01/
```

3. Independently obtain and materialize exact Library current object IDs for `portable-snapshot.sqlite`, `portable-snapshot.manifest.json`, `portable_snapshot.py`, `result.json`. Record actual paths, `file_id`, `library_file_id`, sizes, observation UTC and errors. If one object is absent, report `DISCOVERY_INCOMPLETE`; retry bounded listing, but no assumption of max delay or eventual SLA.
4. Compute SHA-256 of each **locally readable**, materialized file; require exact producer expected sizes/hashes from README, then parse manifest. Require exact `protocol=anet-sqlite-portable-snapshot/research-1`, RUN_ID, selected filename, `size_bytes=28672`, selected SHA-256 and `external_effects_allowed=false`.
5. Use the independently pinned `portable_snapshot.py` verifier on a **copy** of materialized snapshot in a new empty directory (same basename `portable-snapshot.sqlite`). It must return `SNAPSHOT_VERIFIED`, effects=5, count=5, generation=2, commit_sha=`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`, `PRAGMA integrity_check=ok`, and exact effects list SHA-256 `820feef4f6161561310582c0c52fa276421315a1c45d734fd1d3b2271c6dd39b`.

```bash
python3 portable_snapshot.py verify \
  --db ./portable-snapshot.sqlite \
  --manifest ./portable-snapshot.manifest.json \
  --scope run-54
```

6. Use the Git-verified **existing** `sqlite_effect_sink.py` against a *second new copy* of snapshot (never overwrite the verified source). Execute only synthetic local DB operations:

```bash
python3 sqlite_effect_sink.py --db ./replay.sqlite apply \
  --key portable-proof --generation 2 \
  --commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

Require `ALREADY_APPLIED`; counter/effects remain 5. If instead `APPLIED`, FAIL. Submit same key with changed `--payload-hex 646966666572656e74`; require `IDEMPOTENCY_KEY_CONFLICT`. Attempt `install --generation 1 --commit aaaaa... `; require `STALE_AUTHORITY`. All replay operations use synthetic fixture data only, not external APIs.

7. Negative control: flip one byte in a **separate copy** that retains the exact expected basename in its own folder. The SHA verifier must reject it with `SHA256_MISMATCH` before SQLite is opened. Do not mutate the original materialized snapshot.
8. Publish consumer-native UTC, hostname if actually observed, new local data path, Git source identities, Library IDs, hashes, SQLite version, verified row digest, replays/errors and PASS/FAIL/INCONCLUSIVE to [#54](https://github.com/netkeep80/anet-memory/issues/54).

## Allowed final classification

Only `FRESH_CONSUMER_SQLITE_SNAPSHOT_REPLAY_PASS` is accepted if all of the above succeed **in a truly independent new chat**. Cross-sandbox requires the consumer to report a sandbox identity different from producer hostname `5efcb0801173`; merely launching a new process or a new directory on the same hostname does NOT establish it.

This run establishes eventual Library byte availability and restored SQLite idempotency over the published snapshot, **not** the freshness/completeness of the snapshot versus live workers, an authenticated GitHub authority grant, a monotonic protected branch ref, durable persistence of the consumer's newly modified local SQLite file beyond its sandbox life, or exactly-once external HTTP effects. `#54` remains OPEN.
