# Fresh consumer evidence — GitHub -> ChatGPT Library replay

Status: **PASS / FRESH CHAT / DIFFERENT SANDBOX NOT PROVEN**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)

A genuinely fresh consumer independently executed the answer-blind runbook from `CONSUMER.md`.

Before its semantic verdict it did not read publisher live-run evidence, PR #74 evidence, live-run #54 comments, prior transcript/handoff, or Library list/search for the run.

The consumer independently resolved the live authority ref, verified the two-generation Git chain, took the selected Library `file_id` only from the current Git generation record, materialized that exact object, and verified exact size + SHA-256.

Pre-evidence verdict:

`PASS_FRESH_CHAT_CURRENT_REF_SELECTED_LIBRARY_REPLAY`

Required axes:

- `FRESH_CHAT_REPLAY=PASS`
- `DIFFERENT_SANDBOX=NOT_PROVEN`
- `SELECTED_LIBRARY_EXACT_BYTES=PASS`
- `GIT_CHAIN_VALID=PASS`
- `SERVER_SIDE_NON_REWIND=NOT_PROVEN`
- `EXTERNAL_EFFECTS_ALLOWED=false`

After the consumer verdict, the publisher/current thread independently reread GitHub authority and materialized the same exact selected Library `file_id`. Head, descriptor, 209-byte size, SHA-256 and parsed candidate A bytes all matched.

The reported consumer hostname is preserved only as provenance. It is not used to upgrade `DIFFERENT_SANDBOX` because producer sandbox provenance was not independently compared before verdict.

This closes the **fresh-chat replay** gate for the minimal GitHub + ChatGPT Library architecture. It does not close the deferred server-side non-rewind hardening.
