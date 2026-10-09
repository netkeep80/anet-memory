# Safe commit boundaries over Library transport — experimental research

Status: **BOUNDED FUNCTIONAL ACCEPTANCE FOR MEMORY COMMIT SELECTION; NOT AN EXACTLY-ONCE EFFECT PROTOCOL**  
Owner/research record: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
Hardening follow-up: [#87](https://github.com/netkeep80/anet-memory/issues/87)  
Effect/scheduler engineering: [#52](https://github.com/netkeep80/anet-memory/issues/52)  
Dependencies/evidence: [#7](https://github.com/netkeep80/anet-memory/issues/7), [#2](https://github.com/netkeep80/anet-memory/issues/2), [#35](https://github.com/netkeep80/anet-memory/issues/35)  
Original research baseline: `b4ffba91f1a342d4864ccb6e45fea27722bf31f9`, 2026-10-08.

## Target architecture

The target ANet Memory architecture is deliberately minimal:

```text
ChatGPT Library JSON/files  = durable data plane
GitHub                     = control plane / source of truth / commit authority
ChatGPT chat/sandbox       = disposable executor
```

A fresh executor should be able to recover by reading GitHub authority, materializing the exact selected Library bytes, verifying their hashes/chains, and continuing. Library discovery itself is never treated as a commit oracle.

No third-party transactional database is part of the target architecture. PostgreSQL/Supabase/Redis/etc. are out of scope. Existing daemon/SQLite experiments are retained only as historical research/falsifier evidence for crash, replay, idempotency and split-brain behavior; they are not required runtime components and must never become global authority.

The bounded commit-selection question is now answered for the current research model: GitHub expected-head generation advancement selects one exact Library object, losing/orphan Library objects remain uncommitted, and a fresh consumer can reconstruct the selected generation without relying on Library listing/search completeness. Server-side protection against an administrator/capability rewinding or deleting the authority ref is a deliberately deferred hardening layer (#87), not silently assumed.

## Problem

ChatGPT Library listings and search results can temporarily omit files after successful uploads. It also auto-renames duplicate requested filenames on `overwrite=false`, so neither a pathname nor a successful listing is a uniqueness/linearizability oracle.

Literal `sandbox-bus/1` correctly rejects **two observed** divergent same-sequence messages, yet a subset containing just one returns `OK`. Irreversible processing after a temporarily incomplete listing could therefore occur before a hidden fork is discovered.

Current research separates these concepts:

```text
VISIBLE           verified exact bytes, not membership completeness
PREFIX_VALID      observed channel subgraph has no known gap/fork
BATCH_COMPLETE    all entries of ONE manifest are byte-verified
COMMITTED         an authorized, unique commit is proven in a trusted authority
APPLIED           a downstream effect succeeded, under independent idempotency/fencing
```

**No implication from BATCH_COMPLETE to COMMITTED.** A closed manifest alone proves only its explicitly enumerated objects, not absence of a competing invisible manifest. Even a genuine commit cannot guarantee exactly-once external side effects without the downstream system's own idempotency/fencing.

## Executable completeness boundary

`closed-batch.mjs` exports:
- `inspectClosedBatch(manifest, discoveredObjects)`: checks manifest shape, exact file sizes/hashes, literal `sandbox-bus/1` envelope identities, channel sequencing and completeness.
- `inspectCompetingManifests(manifests)`: detects divergent same-run/epoch manifests **when both are observed**.

Every output contains `effect_allowed: false`. `BATCH_COMPLETE` always includes `authority: UNVERIFIED`. These helpers intentionally lack any API to declare a GitHub commit or perform a side effect. They accept caller-supplied manifests as UNTRUSTED observations.

Tests in `test/commit-boundary.test.mjs` cover absent dependencies, out-of-order sequence, complete package, corrupted size/hash/identity, duplicate paths, known fork, competing manifests, and extra unlisted objects.

Run: `npm test` (Node >=20). No production transport or MTS/FORMAL code is modified.

## GitHub authority research — exact experimental outcomes

All tests below occurred on **isolated research branches**; never update production `main` or active experiment namespaces.

### G1 — stale Contents API update

Branch `research/commit-boundary-github-cas-20261008-01`, file `experiments/commit-boundary/evidence/cas-register.json`:

- generation=0 file blob SHA `20635a88fc209c0098d8ded16cf9d32484c492b3`.
- Candidate A wrote generation=1 with expected old SHA: accepted at commit `e980436fcc4982f6b9e37759f23c1258289b92e1`.
- Candidate B's replacement using stale **old** SHA returned explicit **GitHub 409 Conflict**; reread still showed A.

This proves one **sequential** stale-update rejection, NOT concurrent CAS.

### G2 — ABA falsifier: Git blob SHA is NOT a monotonic fencing token

Independent file `.../aba-register.json`, same research branch:

```text
A generation=0       blob a22cbbf6aecd14e0568cbfeeb7e09faa8ac6935d
      |
      v
B generation=1       blob d17a62a02acc490b631370161ae33261405b9697
      |
      v
A exact old bytes    blob a22cbbf6aecd14e0568cbfeeb7e09faa8ac6935d
      |
      v
C STALE old SHA      ACCEPTED commit 0c99071fd3ad54630e29f2c54cc9e8faa76497ea
```

If content returns to identical bytes, SHA returns to the old value. A stale writer can submit an update using the original content SHA. Therefore use a monotonic **history/commit identity** and an explicit no-rewind policy, not blob hashes alone, if relying on this design for safety.

### G3 — branch-ref expected commit SHA

Separate branch `research/ref-cas-20261008-01` prepared git objects off baseline:
- candidate A commit `0881620392fec0cc5f83022c41a54f40344945ad`;
- candidate B commit `fa3d5e68a3efb3bb7af62cfe1351a4f49a36a383` (direct descendant of A, verified GitHub compare 1 ahead);
- alternative C `3c19f70d9956d5d30eaa15b9113f863a8d361e37` (sibling of A, not applied).

`update_ref(expected_sha=baseline, sha=A, force=false)` returned success. Two stale expected-ref attempts `expected_sha=baseline, sha=B` (once `force=false`, once `force=true`) returned generic **`GithubGraphQLAPIError UNKNOWN`**, not an unambiguous lease conflict error. Independent HEAD remained A. Finally `update_ref(expected_sha=A, sha=B, force=false)` succeeded; HEAD became B.

Classification:
- current expected-ref HEAD transitions: **PASS**;
- stale expected-ref safely rejected by a documented conflict code: **INCONCLUSIVE due to ambiguous tool errors**;
- true simultaneous competing writers: **NOT TESTED**.

A proven Git ref serialization authority would require strict allowed writers, expected commit-SHA, monotonic no-force ancestry, verified branch head and a clear failure/retry policy. This tool result does **not** yet establish an end-to-end distributed lock or exactly-once application effects.

Full direct GitHub evidence: [#54 comment 6057182314](https://github.com/netkeep80/anet-memory/issues/54#issuecomment-6057182314).

### G4 — live competing-ref CAS and rewind falsifier (#68)

PR #68 extended the ref test with eight disposable refs and candidates where B is a direct child of A while both claim the same logical lease from the original base.

Observed final heads across the eight races were `A/B/A/B/A/B/A/B`: one final winner per ref. On four refs currently at A, a stale `expected_sha=base` attempt to advance to B was rejected 4/4 even though `A -> B` is a valid fast-forward; independent reads confirmed A remained current.

The same live probe then falsified non-rewind authority under current repository governance:

- `A -> base`, `force=false`: rejected as non-fast-forward;
- `A -> base`, `force=true` with current expected head: **accepted**;
- repository rulesets were empty at the time of the probe.

Strict result:

```text
Git commit/ref expected-head CAS = useful serialization evidence
Git ref under current permissions = NOT non-rewind authority
shared GitHub write capability    = NOT designated-writer authentication
```

Therefore the next work is not to add a database. It is to determine whether GitHub itself can supply a write-once/non-rewind generation authority (for example through appropriately protected refs or immutable release commitments), and to bind that authority to exact Library JSON bytes.

Evidence: [#54 comment 6069912311](https://github.com/netkeep80/anet-memory/issues/54#issuecomment-6069912311).

## Accepted bounded result

The combined research now establishes the following memory-commit boundary:

```text
candidate bytes in ChatGPT Library
        |
        | exact file_id + size + SHA-256
        v
candidate Git generation commit
        |
        | expected-head ref update + authoritative reread
        v
current GitHub authority head
        |
        | exact selected Library object only
        v
fresh disposable consumer
```

Evidence includes:

- closed-batch missing-dependency and competing-manifest falsifiers;
- blob-SHA ABA falsifier;
- live competing expected-head Git ref races with one selected head;
- a real GitHub + Library generation race where both Library candidates remained visible but only one was selected;
- answer-blind fresh-chat replay of the current Git generation chain and exact selected Library bytes;
- repeated observations that Library listing/search can omit an object that exact `file_id` access can read.

For this bounded model:

- `VISIBLE` or `BATCH_COMPLETE` never implies `COMMITTED`;
- `COMMITTED` means selected by the current validated GitHub authority chain under the expected-head protocol;
- losing/unreferenced Library objects are not committed regardless of visibility;
- missing selected Library bytes => pending/fail closed, never fallback by discovery heuristics;
- `COMMITTED` does **not** imply `APPLIED` or exactly-once external effects.

## Explicit assumptions and deferred limits

The functional acceptance does **not** claim protection against a principal with sufficient GitHub authority deliberately rewriting history. Live #68 proved that an unprotected ref could be force-rewound. The prepared ruleset contract from PR #77 is retained, while activation/live proof is explicitly deferred and tracked in #87.

External irreversible side effects remain outside this acceptance boundary. Any such effect requires its own idempotency/fencing semantics; production scheduler/effect engineering remains in #52.

Library discovery is treated as a liveness/convenience mechanism, never an authority or global completeness oracle.

## Follow-up ownership

- **#87:** deferred GitHub server-side non-rewind/delete hardening for `refs/heads/anet-authority/**`.
- **#52:** production scheduler overlap, fencing, durable delivery and irreversible-effect handling.
- **#7:** additional Library consistency/latency characterization when it materially affects behavior.
- **#79 / ARCHITECTURE.md:** architecture evolution and useful multi-project memory behavior.

No third-party transactional database/service is required by the accepted target architecture. daemon/SQLite experiments remain falsifier/regression evidence only.
