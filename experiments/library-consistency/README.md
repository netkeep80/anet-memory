# ChatGPT Library transport capability research

Status: **IN PROGRESS — experimental observations only**  
Owner: [#7](https://github.com/netkeep80/anet-memory/issues/7); bridge: [#35](https://github.com/netkeep80/anet-memory/issues/35); protocol: [#2](https://github.com/netkeep80/anet-memory/issues/2)  
RUN_ID: `libcap-20261008-01`  
Research date: 2026-10-08  
Baseline repository revision: `1afb6abb4d8523ff9573255a6c05f23c7ff677f1`

This experiment studies **ChatGPT Library as an observed object transport**, not as a POSIX filesystem, a transactional message queue, a distributed lock or a guaranteed durable database. Nothing in this report alters the accepted `sandbox-bus/1` message semantics. No claims about platform SLAs can be derived from finite observations.

## Layer distinctions

```text
Kata local path (ephemeral file)
   |
   | 1. optional file-export to conversation snapshot
   v
Exported conversation file_id (exact file bytes; registration may lag)
   |
   | 2. files.manage_library(upload, source_file_ref)
   v
Library object (library_file_id; current backing file_id; actual returned path)
   |
   | 3. list/search/read/materialize (visibility may lag)
   v
Consumer local file (independently verify SHA-256)
```

The alternative `container_path` form uses a platform-side active container-session binding; an independently readable Kata file does not imply that binding is currently available.

Integrity is defined over **exact file bytes**. Neither `file_id`, `library_file_id`, nor a filename is a semantic content digest. A requested path must not be treated as unique authority, because the platform may silently auto-rename a collision.

## Measured observations

| Property | Evidence-backed classification | Limitation |
|---|---|---|
| Local -> exported snapshot -> `source_file_ref` -> Library -> readback | PASS | Obtain a true exported `file_id` and verify before upload |
| Same-turn `source_file_ref` with ID from export notification | PASS for 64 KiB and 1 MiB | ID metadata not consistently surfaced for all exports |
| Same-turn conversation `files.list` indexes newly generated exports | NOT RELIABLE / observed absent in one run | An exact exported ID may already work before listing |
| Next-turn file registration | PASS in tested case | No universal propagation bound |
| `container_path` for identical file/host | Initial FAIL `container_session_expired`, later PASS | Session binding lifetime and cause UNKNOWN |
| `overwrite=false` duplicate exact requested pathname | AUTO-RENAME OBSERVED | NOT atomic create-if-absent or CAS |
| Concurrent requests to one pathname | Two separate objects, original + `(1)` | No guarantee of cross-node ordering or uniqueness |
| `overwrite=true` | Stable `library_file_id`, changed backing `file_id` | Older backing ID was not accessible via attempted Files surface; history semantics UNKNOWN |
| Listing/search immediately after all uploads succeeded | TEMPORARY FALSE NEGATIVE OBSERVED | Full eventual visibility seen later in same chat; cross-chat timing UNKNOWN |
| Readback after materialize | Exact bytes PASS (365 B, 64 KiB, 1 MiB) | No maximum size or atomic visibility SLA proven |
| Retention of an earlier probe | 327 B SHA-verified after approx. 9 h 53 min | Lower-bound observation only; no retention SLA |
| Stable listing order / globally ordered writes | UNKNOWN | Protocol must not use wall-clock or list ordering as authority |
| Fresh independent consumer of current RUN_ID | **PENDING** | Producer reading its own objects is not a fresh-chat test |
| Files materialize -> immediate local stat | A selected path temporarily unavailable in two checks, then complete | Tool-plane local mount/read timing; NOT proof of partial Library object |

### Evidence pointers

- [Initial `container_path` error + research plan](https://github.com/netkeep80/anet-memory/issues/7#issuecomment-6055735314)
- [Snapshot identity, collision auto-rename, overwrite/read behavior](https://github.com/netkeep80/anet-memory/issues/7#issuecomment-6055889474)
- [64 KiB and 1 MiB same-turn bridge](https://github.com/netkeep80/anet-memory/issues/7#issuecomment-6055919744)
- [Distinct-content pathname collision](https://github.com/netkeep80/anet-memory/issues/7#issuecomment-6055967419)
- [Transient listing/search false negative + batch control + retention](https://github.com/netkeep80/anet-memory/issues/7#issuecomment-6056596088)
- [Same-file, same-host `container_path` later succeeds](https://github.com/netkeep80/anet-memory/issues/7#issuecomment-6056617739)

## Listing visibility falsifier: exact chronology

```text
2026-10-08T09:07:11.861Z  three distinct-path uploads ALL returned success
2026-10-08T09:07:18.243Z  first list: discovery-002 and -003; -001 ABSENT
                             scoped filename search also omitted -001
2026-10-08T09:07:31.586Z  second list/search: all three PRESENT
2026-10-08T09:08:00Z      6 parallel subsequent lists: all three PRESENT
```

The initially omitted `discovery-001.json` later materialized by exact returned backing ID, 365 bytes, SHA-256 `f7f32c97450b5bb5549bcdf46f55815f15c4b69384ca76a016e8175ff5783823`, byte-identical to source.

A separate six-object parallel batch returned six exact successful uploads and then listed/searched 6/6 on the first check ~6.7 s later. Thus **not every concurrent upload batch exhibits the same transient miss**.

Do not infer the precise first-visible instant from two poll timestamps. This result refutes *using the first successful post-upload listing as an assumed complete snapshot*, not every possible stronger consistency guarantee that a platform might expose through some other API.

## Research work plan

| ID | Research question | Procedure | Falsifier / exit |
|---|---|---|---|
| LC-01 | Which exact-byte upload bridges work, in which tool-plane state? | Try `container_path` and verified exported snapshot `source_file_ref`; distinguish export, ID registration, upload, listing and readback | Any SHA/size mismatch FAIL; preserve precise failed operation/error |
| LC-02 | How quickly and consistently do distinct readers discover objects? | Coordinated producer and genuinely fresh consumer: poll before publication; compare exact full folder listing, title search, direct IDs; record UTC for every stage | Any missing object recorded as temporary, not silently accepted as absence; collect multiple samples |
| LC-03 | Is object read all-or-nothing at tested sizes? | Bounded 365 B, 64 KiB, 1 MiB, then larger profiles only with exact source manifest; look for absent/complete/partial | A partial/truncated read is FAIL for that observation |
| LC-04 | What happens on collisions and competing writers? | Same requested path, same/different bytes, same bus sequence; include auto-renamed paths; verify all actual paths and envelopes | Never assume requested path == actual path; test real `CHANNEL_FORK` separately |
| LC-05 | Do update/rename/version operations preserve old content addressing? | Isolated mutable test fixtures only; compare old/new IDs, versions and retrieval | A changed old file ID or unavailable version disproves assumed immutable snapshot accessibility |
| LC-06 | What persistence can be directly observed? | Independently materialize pinned older objects on later runs and hash them | Report lower bound only, no SLA inference |
| LC-07 | Can the transport recover from interrupted publication and delayed ACK? | Trigger controlled tool/session failure; restart consumer without prior local state; inspect all actual paths and channel chains | Missing ACK => PENDING, conflict => FORK, no phantom publication or duplicate semantic effect |
| LC-08 | Which worker/sandbox classes can actually execute each bridge? | Fresh interactive chats and scheduled tasks; collect sandbox identity; no semantic handoff | No extrapolation between model/harness, scheduled worker and local daemon |

### Gate ordering

1. **First:** genuinely fresh LC-02 consumer executes [CONSUMER.md](CONSUMER.md); posts checksums and timestamps to #7. Do not claim that a same-chat check substitutes for this.
2. **Then:** synchronized independent producer/consumer visibility sampling across >=10 immutable messages. Count and report missing/list lag and API failures independently; do not invent a latency distribution from samples.
3. **Then:** LC-04 actual valid `sandbox-bus/1` envelopes with same `(source,target,sequence)` but divergent identities; verify `CHANNEL_FORK` fail-closed in literal repository implementation.
4. **Then:** failure/interruption and versioning scenarios; compatibility testing under scheduled and fresh worker contexts.

## Protocol implications (pending adoption in #2)

- Treat Library as a **discovery + immutable-object transport**; not a unique-key journal or lock service.
- For every accepted upload, save the actual server-returned `path`, `file_id`, `library_file_id`, byte size and expected SHA-256 in evidence/control metadata.
- During discovery enumerate the **whole mailbox scope**, including auto-suffixed objects; validate envelopes, dedup by message identity and fail closed for same-channel-sequence forks.
- A missing expected message after one scan is `GAP_PENDING` / incomplete discovery, not proof of loss.
- Never overwrite an accepted immutable message. No exactly-once claim and no use of filename/clock ordering as protocol authority.
- Verify local-file readiness after materialize before execution; a tool-returned path is not itself a validated local SHA.
- All experiments use isolated paths, unique RUN_IDs, UTC timestamps, explicit SHA checks, pinned code, falsifiers and GitHub evidence.

## Non-goals

This research does **not** certify an undocumented API, schedule independent workers automatically, alter #26 endurance or #52 supervisor, replace the ANet logical memory layer or redefine MTS/FORMAL.
