# LC-02 independent fresh-chat Library consumer

Research owner: [#7](https://github.com/netkeep80/anet-memory/issues/7)  
Producer RUN_ID: `libcap-20261008-01`  
Expected repository baseline: `1afb6abb4d8523ff9573255a6c05f23c7ff677f1` (record drift, never silently reinterpret past source)

## Isolation and no semantic handoff

This procedure MUST be executed by a **genuinely new ChatGPT chat**. The prior producer chat, its locally mounted files, semantic transcript and any manually pasted plaintext nonce are forbidden input.

Permitted information:
- this document and [README.md](README.md) at the pinned repository version;
- issue #7 body and its evidence comments for immutable locators, expected sizes and SHA-256 values;
- ChatGPT Library through that new chat's own Files access.

The consumer must independently discover and materialize the Library objects. Merely repeating hashes from this document is **not** evidence of reading them. A scheduled continuation inheriting the originating chat context is **not** a genuinely fresh-chat consumer.

## Discovery path

```text
/anet-memory/experiments/library-consistency/libcap-20261008-01/
```

1. Record new chat's observed UTC and, if a Kata shell is actually allocated, its hostname; do not invent/guess an identity or assume it's different from producer.
2. Read the current #7 procedure/evidence directly from pinned GitHub references and record current `main` drift separately.
3. Call `files.list(surface="library", library_path=<exact folder>)`, paginate if needed, and save the full result set (name, actual path, file_id, library_file_id, size, response timestamp). Do not rely on fuzzy semantic search or directory order.
4. If an expected object is absent, report `DISCOVERY_INCOMPLETE` and recheck according to a bounded explicit poll schedule; a single absent listing is **not** proof of deletion.
5. Compare title search, if desired, separately; a search result cannot override a verified folder list or a byte hash.

## Required immutable readback matrix

Materialize the following objects using consumer-observed IDs from the Library listing, into a NEW empty local directory. Independently compute byte count and SHA-256 by reading the newly materialized local bytes.

| Object name | Expected exact bytes | Expected SHA-256 |
|---|---:|---|
| `small-source-ref.json` | 365 | `f7f32c97450b5bb5549bcdf46f55815f15c4b69384ca76a016e8175ff5783823` |
| `size-65536.bin` | 65536 | `33c39cbb22363d0736b0845fdc8589a1b6888ee0d4edf7da8e2470d33d32e455` |
| `size-1048576.bin` | 1048576 | `df8a0d5de7f95cfdfae8ee8845f572968fd160f3445897856c2356e102fd7721` |
| `different-payload-collision.dat` | 365 | `f7f32c97450b5bb5549bcdf46f55815f15c4b69384ca76a016e8175ff5783823` |
| `different-payload-collision(1).dat` | 65536 | `33c39cbb22363d0736b0845fdc8589a1b6888ee0d4edf7da8e2470d33d32e455` |
| `discovery-001.json` | 365 | `f7f32c97450b5bb5549bcdf46f55815f15c4b69384ca76a016e8175ff5783823` |
| `discovery-002.json` | 365 | `f7f32c97450b5bb5549bcdf46f55815f15c4b69384ca76a016e8175ff5783823` |
| `discovery-003.json` | 365 | `f7f32c97450b5bb5549bcdf46f55815f15c4b69384ca76a016e8175ff5783823` |

For each JSON object, AFTER verifying the raw-file hash, parse and validate `run_id` / control field from the local copy. Do not use publisher prose or old chat context to supply a hidden nonce.

Also discover the six `visibility-batch-02/batch2-01.json` through `batch2-06.json` objects in their nested folder and materialize a documented sample (at least three); the source payload is identical 365-byte JSON. The folder may appear as a child of the main experiment folder.

## Error handling

- If a Files tool returns a destination path but immediate local stat/read fails, check the path in a separate explicit attempt and report timing. Never mark a file validated before the bytes are locally readable and SHA-verified.
- `file_id` and `library_file_id` are recorded as physical lookup identifiers, not content hashes.
- A query returning different names with the same content is not a content collision.
- The intentional `(1)` pathname is essential. Do not silently collapse auto-renamed entries.
- If a requested object remains unavailable, record all call details and classify `FAIL` or `INCONCLUSIVE` based on evidence; never invent bytes or fill a gap from the publisher's chat.
- Do not modify or delete source Library files.
- Do not create comments on #26 or #52.

## Report back to issue #7

Publish:
- independent chat type, UTC and observed hostname (if available);
- GitHub source revision and live `main` drift;
- complete observed paths/file IDs, including collision suffix;
- producer evidence SHA expectations versus independently recomputed hashes;
- each file size and `PASS/FAIL/INCONCLUSIVE`;
- missing objects, listing/search discrepancies and each tool error;
- whether any source nonce was learned solely from materialized bytes;
- observed latency **only relative to explicit producer timestamps** and with clock/sampling uncertainty clearly explained;
- final assertion **`FRESH_CONSUMER_BYTE_IDENTITY`** with status `PASS`, `FAIL`, or `INCONCLUSIVE`.

A fresh consumer reading a publication made earlier can establish eventual visibility and byte identity, but **cannot alone establish a read-after-write latency distribution**. The synchronized, pre-polling two-worker experiment remains a separate LC-02 requirement.

No semantic handoff, no manual source reconstruction and no assertion of ChatGPT Library SLA.
