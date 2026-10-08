# Minimal GitHub + ChatGPT Library generation protocol

Status: **RESEARCH ONLY / NO EXTERNAL EFFECTS**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)

## Purpose

This experiment tests the minimal target ANet Memory architecture:

```text
ChatGPT Library JSON/files = durable data plane
GitHub                    = control plane / source of truth / commit authority
ChatGPT chat/sandbox      = disposable executor
```

No daemon, SQLite, PostgreSQL, Supabase, Redis or other transactional service is required by this protocol.

The core idea is simple:

> Library stores candidate bytes. GitHub decides which exact bytes are committed.

Library listing/search completeness is therefore not needed to decide commitment. A consumer follows only the exact Library object selected by the current GitHub generation record.

## Identity rule

Human-readable run labels are **not** authority identifiers. A duplicated or reused `RUN_ID` must never merge two attempts semantically.

Authoritative identity comes from the GitHub authority scope/head/commit chain plus the exact Library object identifiers and hashes selected by that chain. A prepublication attempt that never creates a Library object or Git authority commit cannot conflict with a later committed generation merely because it reused the same text label.

Operationally, future experiments should still use unique attempt IDs to avoid audit confusion.

## Generation record

A generation record is small control-plane metadata stored in GitHub:

```json
{
  "schema": "anet-github-library-generation/research-1",
  "scope": "anet-memory.main",
  "generation": 2,
  "predecessor_commit": "0123456789abcdef0123456789abcdef01234567",
  "root": {
    "path": "/anet-memory/v1/state/g00000000000000000002/root.json",
    "file_id": "file_...",
    "size_bytes": 1234,
    "sha256": "..."
  },
  "application_effects_allowed": false
}
```

The `root` object may itself be a manifest that names additional exact Library objects.

The Git commit containing generation `N+1` MUST have parent exactly equal to the Git authority commit for generation `N`. The record's `predecessor_commit` MUST name the same commit.

## Publisher algorithm

Given current authority head `Hn`:

1. read `Hn` from the dedicated GitHub authority ref;
2. fetch and validate generation record `Rn`;
3. materialize the Library root selected by `Rn` and verify exact size + SHA-256;
4. produce/upload candidate JSON or manifest bytes to ChatGPT Library;
5. record the exact Library `path`, stable `file_id`, byte size and SHA-256;
6. create `Rn+1` with `generation = n + 1` and `predecessor_commit = Hn`;
7. create immutable candidate Git commit `Cn+1` whose parent is exactly `Hn`;
8. attempt:
   `update_ref(expected_sha=Hn, sha=Cn+1, force=false)`;
9. independently reread the ref before interpreting the result.

Outcome classification:

- ref == `Cn+1` -> **COMMITTED**;
- mutation errored and ref still == `Hn` -> **SAFE_RETRY_SAME_CANDIDATE**;
- ref points to another commit -> **LOST_RACE**;
- API reported success but ref does not point to `Cn+1` -> **FAIL_CLOSED_INCONSISTENT_SUCCESS**.

A losing publisher's Library bytes are merely orphan/uncommitted objects. Their existence does not create a competing committed generation.

## Consumer algorithm

1. read the GitHub authority ref;
2. fetch the exact generation record from that commit;
3. validate schema, generation and predecessor structure;
4. materialize the exact Library object named by `file_id/path`;
5. verify exact size and SHA-256;
6. only then expose the generation as usable committed state.

If the selected Library object is temporarily not visible, classification is **PENDING_LIBRARY_OBJECT**. The consumer must not infer that some older generation is therefore current, and must not select an unreferenced Library object merely because it is visible.

## Why incomplete Library discovery is tolerable

The protocol never asks:

> "Have I listed every object in Library?"

It asks:

> "Can I materialize the exact object selected by the current GitHub authority commit, and do its bytes match?"

Temporary omission therefore affects liveness, not selection semantics.

## Concurrency model

Two chats may start from the same `Hn`, upload different Library candidates and create different candidate commits.

Only one can become the authority head if both obey expected-head CAS. The loser rereads GitHub, observes a different head and classifies its candidate as uncommitted.

No Library delete/rename is needed to resolve the race.

## PR merge history is not generation authority

A parallel disposable #54 probe produced an important negative result:

- PR #71 candidate A and PR #72 candidate B both claimed logical generation 1 from the same predecessor;
- #71 was merged into a disposable research base;
- that base ref was then force-rewound;
- #72 was subsequently also merged;
- both PRs therefore remain `merged=true` while selecting different logical candidates for the same generation.

So **"merged PR" is historical evidence, not a uniqueness oracle**. Consumers must not scan merged PRs and infer the current generation from merge status alone.

The authoritative selector in this protocol is the current Git ref head plus its verified parent/generation chain. PRs may be used as a review workflow around candidate commits, but their merged state does not replace expected-head CAS or server-side no-rewind protection.

## Current hard boundary

Live #68 evidence shows that expected-head Git ref updates provide useful CAS/serialization behavior, but the current repository/credential can also perform a deliberate `force=true` rewind.

Therefore this experiment does **not** claim server-side non-rewind authority under current governance.

Current classification target:

- Library exact-byte selection: executable verifier;
- generation transition structure: executable verifier;
- CAS outcome resolution: executable verifier;
- GitHub server-side no-rewind: **NOT YET PROVEN**;
- external effects: **FORBIDDEN**.

A future GitHub-only hardening step may use repository rulesets/protected refs or Immutable Releases, but those properties must be live-tested before acceptance.

## Falsifiers

The tests require rejection/fail-closed behavior for:

- generation gap;
- scope change;
- record predecessor mismatch;
- actual Git parent mismatch;
- malformed Library descriptor;
- wrong Library size;
- wrong Library SHA-256;
- missing selected Library object;
- stale writer that loses the ref race;
- ambiguous mutation error with unchanged authority head;
- reported mutation success contradicted by authoritative reread;
- visible orphan Library object not selected by GitHub.

The protocol intentionally has no API that turns Library visibility alone into `COMMITTED`.
