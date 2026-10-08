# SQLite crash/ACK-loss/fencing probe — actual OS subprocess experiment

**Research only, not production ANet transport.**  
Issue: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
RUN_ID: `sqlite-crash-20261008-01`  
First execution: 2026-10-08, Kata hostname `5efcb0801173`, SQLite `3.46.1`.

## Why this experiment exists

The companion [effect-replay model](../EFFECT-REPLAY.md) only simulates an atomic receiver in one JavaScript process. This probe uses **real SQLite transactions and distinct OS processes**, deliberately kills the worker with `SIGKILL` before or immediately after database COMMIT, and independently opens the same persistent database file in new processes.

It tests transaction consistency/deduplication **within one live disposable Kata filesystem**, not persistence after reassignment to a new ChatGPT sandbox and not an external HTTP action.

## Files

- [`sqlite_effect_sink.py`](sqlite_effect_sink.py) — Python standard-library `sqlite3` CLI, SQLite WAL mode, `synchronous=FULL`, `BEGIN IMMEDIATE`, durable effects table with `PRIMARY KEY(scope,effect_key)`, synchronized counters updated **inside the same transaction**, monotonic `authority(scope,generation,commit_sha)`.
- [`run_probe.py`](run_probe.py) — launches actual child processes; two subprocesses get `SIGKILL` at distinct failpoints, then verifies durable state and replays.
- [`result.json`](result.json) — exact original machine-readable successful output.

Exact source/evidence hashes (independent from filenames):

| Artifact | Exact bytes | SHA-256 | Git blob SHA-1 |
|---|---:|---|---|
| `sqlite_effect_sink.py` | 4230 | `eae221cd62a8241d0ef73d03f2e4a716754d780bf3ee27e0de7a5c3e4a90ff6b` | `3822f334752f10c2744d241fefe6d402b32aaa21` |
| `run_probe.py` | 3646 | `80b76db0324e68ce0b1d9ea121ed8b9a9aab82596d7be3746acdc5136eb090c7` | `c59a7f30e7743fe22645abcff622943981251d72` |
| `result.json` | 841 | `a12f42cfd05bfe7c8aeafe689329d0add244197745bf07892c0487d3aa429c2d` | `970f85501bf22478cce295816f971bc8f7b4c330` |

All three exact bytes were independently uploaded to isolated ChatGPT Library, then materialized, and the GitHub created blobs were verified equal to the original local Git blob SHA-1s.

Library namespace:

```text
/anet-memory/experiments/commit-boundary/sqlite-crash-20261008-01/
  sqlite_effect_sink.py
  run_probe.py
  result.json
```

## Repeat in a new scratch directory

The runner intentionally deletes the **dedicated fixture database** `run-54-sqlite.db` and associated WAL/SHM files in its own directory before running. To avoid dirtying the repository checkout or disturbing another run, **copy the two .py sources to a NEW empty sandbox directory** before executing; do not run it in a shared or production data directory.

```bash
mkdir -p /tmp/anet-sqlite-crash-repro-001
cp experiments/commit-boundary/sqlite-crash/*.py /tmp/anet-sqlite-crash-repro-001/
python3 /tmp/anet-sqlite-crash-repro-001/run_probe.py
```

Expected platform: Python stdlib sqlite3 with WAL, POSIX `SIGKILL`, local writable FS. No GitHub API/ChatGPT Library connection needed for local replay. The executable itself has **no code path to approve or publish semantic authority**. It does not receive or inspect MTS/FORMAL payloads.

## Exact tested scenarios and results

| Scenario | Observed state |
|---|---|
| `SIGKILL` before SQLite transaction COMMIT | Transaction rolled back; counter and effect count stayed 0 |
| Restart/replay the uncommitted request | Exactly one effect record and counter increment |
| `SIGKILL` immediately after COMMIT, before ACK emission | Counter/effect durable at 2 |
| Retry identical key + digest | `ALREADY_APPLIED` without counter increment |
| Replay same key with different bytes | `IDEMPOTENCY_KEY_CONFLICT` |
| Eight independently spawned OS processes with same new effect key | 1 `APPLIED`, 7 `ALREADY_APPLIED`; counter increased once |
| Install generation 2, submit effect from generation 1 | `STALE_OR_FUTURE_GENERATION` |
| Reinstall older generation or different commit at same generation | `STALE_AUTHORITY` and `AUTHORITY_FORK` |
| Final scoped counter/effects | 4 / 4; generation 2 |

**Classification:** `PASS_LOCAL_SQLITE_PROCESS_CRASH_REPLAY`. The sink's counter is deliberately modified **inside** its idempotency transaction; no external side effects are performed.

## Critical boundaries / falsifiers still open

1. The authority installation CLI **accepts generation and commit SHA from the caller**; it does not authenticate a GitHub ref or enforce branch rules. Untrusted callers can falsely install a later generation. Thus this is *not* a secure fencing service.
2. SQLite's local database file is durable **only for the observed continuous Kata guest/filesystem**. The project has already observed sandbox reassignment/lost `/mnt/data` state. No cross-chat durability is claimed.
3. A DB transaction protecting the counter does not automatically protect external actions (email, HTTP request, payment, independent GitHub mutation). For those, the target system must supply durable idempotency and appropriate fencing, or one must accept at-least-once/compensating saga behavior.
4. The test does not constitute a concurrent GitHub CAS proof. The earlier ref-race losing call returned an ambiguous GraphQL error.
5. A real trusted endpoint must tie its authority snapshot to independently verified no-rewind commit history and independently authorized writers, protect against credential forgery/rotation, and fail closed on unknown staleness.
6. The standard artifact pipeline must still be independently repeated by a fresh chat using GitHub-pinned source and Library manifest, without semantic handoff.

**Do not close #54** merely because this local transactional effect simulator passed.
