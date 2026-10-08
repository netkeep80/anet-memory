# Fresh consumer: GitHub-selected Library manifest

Research owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
Parent experiment: `libcap-manifest-20261008-03`  
Selection RUN_ID: `github-library-selection-20261008-01`  
Authority *candidate* branch: `research/library-git-authority-20261008-01`  
Pinned Git commit: `5fbab3719dcd5761b759997da14b78118d0ed883`  
Expected parent: `007b38ae8ee2fa0967ad8e6ce78f724d76e7e2e4`  
Expected record Git blob: `0d6569e47586dcd916aba273500188f6133ebee7`

## Purpose

Independent cross-chat replication of a **GitHub reference selecting exact bytes held in ChatGPT Library**, despite an alternative manifest existing in the Library namespace. It is NOT acceptance of a distributed lock or permission for irreversible application effects.

Perform in a **genuinely new ChatGPT chat**. No semantic handoff/transcript/producer-local files or manually pasted hidden nonce. Use only this pinned procedure, GitHub, and fresh Files Library lookups. Record all observed tool timestamps and runtime identity actually available. Do not create or modify any source object or issue #26/#52.

## 1. Verify GitHub selector

1. Read this file from GitHub pinned to merged version containing this procedure; distinguish procedure-version drift from research selection commit.
2. Fetch exact commit `5fbab3719dcd5761b759997da14b78118d0ed883` in `netkeep80/anet-memory`; check its single parent is `007b38ae8ee2fa0967ad8e6ce78f724d76e7e2e4`.
3. Read `experiments/commit-boundary/evidence/selected-library-manifest.json` at the **pinned selection commit**, not unpinned `main`. Independently verify Git blob SHA `0d6569e47586dcd916aba273500188f6133ebee7`.
4. Fetch LIVE HEAD of `refs/heads/research/library-git-authority-20261008-01`; require exact match to pinned selection commit for `HEAD_MATCH`. If not, report drift and classify authority-current-state **INCONCLUSIVE**; never substitute current head silently.
5. Validate selector `protocol=anet-commit-selection/research-1`, `run_id`, `epoch`, `expected_parent_commit_sha`, exact selected Library `path/file_id/size_bytes/sha256`, and `application_effects_allowed=false`.

## 2. Materialize exactly the selected manifest

From the GitHub-verified record alone, identify the selected Library object:

```text
/anet-memory/experiments/library-consistency/libcap-manifest-20261008-03/manifest.json
```

Call `files.list(surface="library",library_path=<parent-folder>)`, record actual returned file_id/library_file_id/name/path/size and observation UTC. Do not select by fuzzy search ranking.

Materialize exact selected `file_id` into a new empty sandbox directory. Independently read exact file bytes and compute SHA-256. Required:

```text
size_bytes = 872
sha256 = b4b56bb7ac501ffb71099d32abbd0f19053266310b6fb43bc6b67f10e400f116
```

Do **not** silently rewrite the legacy source manifest to match the new research `anet-closed-batch/research-1` schema.

## 3. Validate legacy manifest and each referenced object

The exact source uses profile `anet-memory/closed-batch-probe/1`, with `objects[]`, `channel{source,target}`, `publisher`, `run_id`, `epoch` and `object_count`.

Check `object_count=2`, channel identities and distinct paths; materialize ONLY named objects from the Library `messages/` child folder:

```text
messages/000000000001--5dc6446d-00ce-4b4e-881a-593f08f51016.json
messages/000000000002--14a9c00a-dbee-4c4c-b0d8-f7afc03c140d.json
```

Independently hash bytes and ensure they match the **manifest itself** (do not derive the hashes from this prose). As cross-check, published producer evidence records:

| Sequence | Expected exact bytes | SHA-256 |
|---|---:|---|
| 1 | 578 | `d0cc895be0bf99949a3bae6755b9b1e1f3694ab61addefaa3b4d5c09a1d3cf83` |
| 2 | 612 | `dd4b5618bfe1a8b4ee66d43626ef9e02000731c8066915315b1c1e440e8108` |

For every referenced message, verify:
- `protocol=sandbox-bus/1`;
- `source,target,message_id,sequence,previous_message_id` against manifest;
- payload encoding is canonical Base64;
- decoded exact payload SHA-256 equals envelope `payload_sha256`;
- seq1 genesis `previous_message_id=null`, seq2 `previous_message_id=seq1.message_id`.

Optional strongest check: fetch literal repository `src/sandbox-bus.mjs` at exact selection commit; run literal `parseEnvelope` and `inspectChannel` over both materialized messages, pinned source blob integrity verified before execution.

A tool returning a local destination path is NOT equivalent to a successful local read; if mount/read lags, retry explicitly with recorded observation times.

## 4. Distinguish competing unselected Library manifest

The same Library parent folder should also contain `manifest(1).json` from the adversarial test, with SHA-256:

```text
3b31f4bfa9bde83300d87a1bfaf102fd5fd4aa4e14697b9661115959137e6b48
```

Inspect its run_id/epoch **after** verifying the selected manifest; confirm its differing `object_count` / content. It is a valid observed rival on the *untrusted Library plane*, but the pinned Git commit refers only to `manifest.json`. Do not claim the Git commit proves the rival cannot later become selected by a different ref update or that the ref cannot be force-rewritten. Record any missing/invisible rival as an observation, not as proof of absence.

## 5. Classify precisely and report to #54

- `GIT_RECORD_VERIFIED`: pinned commit parent and record blob SHA match.
- `HEAD_MATCH`: live research branch HEAD matches pinned commit at time observed (not a permanent pin).
- `SELECTED_MANIFEST_BYTES_VERIFIED`: exact selected Library bytes hash to commit reference.
- `SELECTED_OBJECTS_VERIFIED`: both referenced messages have exact hashes, valid envelopes and sequence chain.
- `COMPETING_UNSELECTED_MANIFEST_OBSERVED`: rival is present with distinct SHA on Library plane.
- `FRESH_CONSUMER_SELECTION_REPLAY_PASS`: all required checks succeed in genuinely new chat.
- `COMMITTED_GLOBAL_AUTHORITY`: **NOT PROVEN** by this run, regardless of previous flags.
- `EXTERNAL_EFFECTS`: **FORBIDDEN**, no actions and no processed ACK.

Report independent chat identity and actual hostname (if available), UTC times, used pinned revision, observed Library file IDs/actual paths and recomputed checksums, GitHub branch drift, and all errors. Link evidence to [#54](https://github.com/netkeep80/anet-memory/issues/54); keep #26/#52 untouched.

The result is valid only for the observed GitHub record/Library objects under these capabilities; it is not a Library retention SLA, an atomic create/CAS guarantee, or authorization to run tasks on behalf of another writer.
