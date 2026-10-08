# Safe commit boundaries over Library transport — experimental research

Status: **RESEARCH ONLY, NOT AN ACCEPTED COMMIT OR FENCING PROTOCOL**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
Dependencies: [#7](https://github.com/netkeep80/anet-memory/issues/7), [#2](https://github.com/netkeep80/anet-memory/issues/2), [#35](https://github.com/netkeep80/anet-memory/issues/35)  
Baseline: `b4ffba91f1a342d4864ccb6e45fea27722bf31f9`, 2026-10-08.

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

## Research directions

1. Independent fresh-chat LC-02 consumer in [#7](https://github.com/netkeep80/anet-memory/issues/7), exact Library byte readback, no transcript.
2. Test a *real* competing-writer ref race using a tool/API that gives unambiguous conditional-update outcomes, and record both branch history and losing responses. This repository's available Contents API connector explicitly advises against parallel writes on the same path; do not violate that contract to manufacture a race.
3. Verify history no-rewind constraints by branch rules/permissions, or label them explicit external trust assumptions. A writable unprotected ref is not an immutable ledger.
4. Tie a GitHub-authorized manifest commitment to independently read Library objects and verify exact SHA-256 in a genuinely fresh consumer. Partial listing => pending, conflicting Library objects not included in the commit => uncommitted/untrusted.
5. Model downstream idempotent effects and stale-worker outputs separately from the Git commit record, including crash after effect but before ACK.
6. Never use a fixed sleep or a single successful list as proof of globally complete discovery; no Library maximum visibility lag or strong listing guarantee has been established.

**Acceptance boundary:** #54 remains OPEN until a concrete commit/authority protocol passes adversarial, independent, multi-writer and recovery falsifiers. The module in this experiment is only a safe preliminary completeness checker.
