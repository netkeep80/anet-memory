# Publisher runbook — history/rationale experiment

Owner: #46

## 1. Pin repository state

Record:
- exact main commit;
- successful CI run;
- successful `Source bundle / history-rationale` workflow run;
- source bundle artifact ID.

## 2. Publish the authoritative executable source bundle

Download the workflow artifact:

```text
anet-memory-source-bundle-history-rationale-<PINNED_SHA>
```

Extract the inner self-contained:

```text
anet-memory-source-bundle-history-rationale-<PINNED_SHA>.mjs
```

Verify its outer SHA-256 and publish that exact file to Library:

```text
/anet-memory/v1/source-bundles/<PINNED_SHA>/history-rationale.mjs
```

Record the outer SHA-256 in #46.

## 3. Prepare the deterministic semantic fixture

Materialize/verify/unpack the same source bundle in a publisher Kata, then execute the literal bundled fixture builder:

```bash
node <UNPACKED>/experiments/history-rationale/prepare.mjs \
  --memory-root /tmp/anet-history-publisher/memory \
  --run-id <RUN_ID>
```

Do not manually recreate the fixture.

## 4. Export through the literal bundled snapshot CLI

```bash
node <UNPACKED>/experiments/fresh-chat-bootstrap/snapshot.mjs export \
  --memory-root /tmp/anet-history-publisher/memory \
  --out /tmp/anet-history-export \
  --manifest-id <RUN_ID> \
  --project anet-memory-history-test \
  --root-artifact <RUN_ID>-task \
  --provenance github:issue/46 \
  --provenance github:commit/<PINNED_SHA>
```

Publish every object first, then the manifest LAST.

Never overwrite an earlier run ID.

## 5. Publisher self-check

Using a fresh empty local root and the literal bundled CLI:
- import the exported snapshot;
- run current-state bootstrap;
- run D1 historical projection;
- run R1 historical projection.

Publisher self-check is diagnostic only. It is not the fresh-consumer PASS.

## 6. Record evidence

Post to #46:
- RUN_ID;
- pinned commit / CI / workflow;
- source bundle Library path + outer SHA;
- source bundle file/blob inventory;
- semantic manifest Library path + SHA;
- object count;
- publisher diagnostic results.

Then launch a genuinely fresh consumer with only repository/run locators and procedure.
