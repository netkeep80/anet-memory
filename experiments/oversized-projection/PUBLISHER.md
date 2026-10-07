# Publisher runbook — oversized projection benchmark

Owner: #49

## 1. Pin successful main

Record:
- exact `main` commit;
- successful CI run;
- successful `Source bundle / oversized-projection` job;
- successful `Oversized projection benchmark / build-benchmark` run.

Do not use an artifact produced from a non-main commit.

## 2. Publish exact consumer source

Download:

```text
anet-memory-source-bundle-oversized-projection-<PINNED_SHA>
```

Extract the inner `.mjs`, compute its outer SHA-256, and publish the exact file:

```text
/anet-memory/v1/source-bundles/<PINNED_SHA>/oversized-projection.mjs
```

Record outer SHA, profile, file count and bundled Git blob IDs.

## 3. Obtain authoritative semantic benchmark artifact

Download the `Oversized projection benchmark` artifact produced from the same pinned main commit.

It contains:
- `benchmark-export/` — exact semantic Library objects + manifest;
- `benchmark-meta.json` — object counts, exact corpus bytes, query budget, answer commitment;
- `benchmark-verification.json` — publisher diagnostic projection hashes/IDs without plaintext answer.

Do not publish `_benchmark-expanded.json` or any plaintext answer.

## 4. Publish semantic objects to Library

Upload every artifact/event to the exact `/anet-memory/v1/...` path encoded by the export.

Upload the manifest **LAST**.

Never overwrite an earlier run. Every benchmark Actions run has a unique run ID.

## 5. Cold readback

Rediscover/materialize source bundle, all manifest-referenced semantic objects and manifest from Library.

Require exact byte equality / SHA-256 before launching consumers.

## 6. Publisher evidence

Post to #49 only non-secret evidence:

```text
RUN_ID
pinned main commit
CI/workflow IDs
source bundle Library path
source bundle outer SHA
bundled Git blob inventory
manifest Library path + SHA
object count
exact semantic corpus bytes
corpus / 8000 ratio
answer commitment SHA-256
publisher shallow projection SHA-256
publisher expanded projection SHA-256
publisher selected node IDs and budget accounting
Library cold-readback result
```

Do **not** post plaintext `verdict` or `evidence_token`.

Then launch two genuinely fresh chats: `consumer-a` and `consumer-b`.