# Fresh consumer runbook — live GitHub + Library generation

Status: **FRESH-CHAT REPLAY GATE / NO EXTERNAL EFFECTS**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)

This runbook is deliberately answer-blind. It names the authority surface but does **not** contain the current authority head, the winning or losing candidate commit, the selected Library `file_id`, or any expected selected-object SHA-256.

## Goal

From a genuinely fresh ChatGPT chat, independently recover the currently selected research generation using only:

```text
GitHub authority ref
  -> exact generation commit/parent chain
  -> exact Library file_id selected by that chain
  -> independently materialized bytes
```

The consumer must not use transcript replay, semantic handoff, memory of the publisher chat, or any pre-supplied winner identity.

## Pinned generic protocol source

Repository:

`netkeep80/anet-memory`

Generic protocol baseline:

`40a8d23df637c6706ba39d525016ed56af080f3c`

Before the semantic verdict, the consumer may read only these repository protocol files at that pinned baseline:

- `experiments/commit-boundary/github-library-generation/README.md`
- `experiments/commit-boundary/github-library-generation/generation-protocol.mjs`
- this `CONSUMER.md`

Do not infer current authority from that pinned baseline. It is only the verifier/protocol definition.

## Live authority locator

Authority ref:

`refs/heads/research/github-library-live-authority-20261009-01`

Generation record path inside each authority commit:

`experiments/commit-boundary/evidence/github-library-generation-live-20261009-01/generation.json`

These locators identify where to look. They do not identify the current generation or selected Library bytes.

## Isolation rules before verdict

Before producing the semantic verdict, **MUST NOT** read:

- `experiments/commit-boundary/github-library-generation/live-run-20261009-01/README.md`;
- `experiments/commit-boundary/github-library-generation/live-run-20261009-01/result.json`;
- PR #74 body, diff, comments, or merged evidence;
- #54 comments published after the generic protocol acceptance if they discuss the live run;
- any prior chat/transcript/handoff describing the live run;
- Library folder listings or Library search results for the live run.

Do not use the human-readable run label as authority identity.

If any forbidden source is read before the verdict, classify the run:

`INVALID_ISOLATION_CONTAMINATION`

and stop.

## Consumer procedure

### 1. Record fresh execution provenance

Record:

- fresh-chat role: `consumer`;
- local hostname if a local sandbox is available;
- current wall-clock time;
- pinned generic protocol commit above.

A hostname alone does not prove a different sandbox unless compared with independently recorded producer provenance. Do not upgrade `FRESH_CHAT` to `DIFFERENT_SANDBOX` without evidence.

### 2. Resolve the live Git authority ref

Read the exact Git ref:

`refs/heads/research/github-library-live-authority-20261009-01`

Record the returned current commit SHA as `H_current`.

Do not use GitHub Search to guess the head. Do not use a remembered SHA.

### 3. Fetch and validate the current generation record

At exactly `H_current`, fetch the canonical generation-record path.

Validate using the pinned generic protocol:

- exact supported schema;
- valid scope;
- positive integer generation;
- valid Library descriptor;
- `application_effects_allowed === false`.

Record the generation number, scope, predecessor field, and exact root descriptor only after reading them from GitHub.

### 4. Verify the Git predecessor chain

Fetch the Git commit object for `H_current`.

For every generation greater than 1:

- the generation record's `predecessor_commit` MUST equal the commit's actual first/only parent used by this authority chain;
- fetch the predecessor commit directly by SHA;
- fetch the same canonical generation-record path from that predecessor;
- predecessor scope MUST be identical;
- predecessor generation MUST be exactly current generation minus one.

Walk backward until generation 1.

Generation 1 MUST have:

`predecessor_commit = null`

Reject any gap, scope change, record/Git-parent mismatch, missing record, or malformed descriptor.

Do not follow the current branch name backward by search. Follow exact commit SHAs from the verified chain.

### 5. Materialize only the Git-selected Library object

Take the `root.file_id` from the current Git generation record.

Materialize **that exact file_id directly** through the persistent ChatGPT Library file surface.

Before the verdict:

- do not list the containing folder;
- do not search by filename/path;
- do not substitute another object with similar name/content;
- do not accept a visible object that GitHub did not select.

If the exact selected file_id cannot currently be materialized, classify:

`PENDING_SELECTED_LIBRARY_OBJECT`

and stop without falling back to an older generation.

### 6. Verify exact selected bytes

On the independently materialized bytes:

- size MUST equal Git `root.size_bytes`;
- SHA-256 MUST equal Git `root.sha256`;
- materialization result `file_id` MUST equal the Git-selected `root.file_id`.

If any mismatch exists, fail closed.

Only after all exact checks pass may the root JSON be parsed for informational reporting.

### 7. Produce the pre-evidence verdict

If all steps pass, report:

`PASS_FRESH_CHAT_CURRENT_REF_SELECTED_LIBRARY_REPLAY`

Also report, separately:

- discovered authority head SHA;
- discovered generation;
- discovered predecessor chain;
- selected Library file_id;
- selected byte size;
- selected SHA-256;
- parsed root identity/content summary;
- `external_effects_allowed=false`;
- `server_side_non_rewind=NOT_PROVEN`.

This verdict means the fresh chat can reconstruct the state selected by the **currently observed** Git authority ref. It does **not** prove that the ref cannot have been rewound before the consumer arrived.

### 8. Only after verdict: optional evidence comparison

After the pre-evidence verdict has been fixed, the consumer may read the previously forbidden live-run evidence and/or list the Library folder to compare its independent result with the publisher record.

A visible losing/orphan Library object must not alter the already-derived Git selection.

If post-verdict evidence disagrees with the independently derived head/file/hash, report the discrepancy explicitly; do not rewrite the earlier observation.

## Required final classifications

Always include these independent axes:

- `FRESH_CHAT_REPLAY`: PASS / FAIL / INVALID
- `DIFFERENT_SANDBOX`: PASS only with independent provenance comparison, otherwise NOT_PROVEN
- `SELECTED_LIBRARY_EXACT_BYTES`: PASS / FAIL / PENDING
- `GIT_CHAIN_VALID`: PASS / FAIL
- `SERVER_SIDE_NON_REWIND`: NOT_PROVEN
- `EXTERNAL_EFFECTS_ALLOWED`: false

Do not mark #54 accepted from this consumer run alone.
