# Publisher runbook — fresh-chat bootstrap

Run owner: #40  
Source transport owner: #36

## Preconditions

- Work from the exact pinned repository commit recorded for the run.
- Build the source bundle from that exact checkout.
- Use a **dedicated** local memory root for this experiment.
- Do not copy a raw chat transcript into semantic artifacts.
- Encode only:
  - user-accepted decisions/instructions as author-accepted lifecycle;
  - externally observed GitHub/test evidence as observed/verified lifecycle;
  - model-generated interpretations as proposals unless the user explicitly accepted them.

## 1. Build the immutable executable source bundle

The consumer must be able to execute the literal pinned repository implementation without guest GitHub network access.

Build one self-contained source bundle:

```bash
node experiments/source-bundle/source-bundle.mjs build \
  --root . \
  --out /tmp/anet-fresh-source-bundle.mjs \
  --repository netkeep80/anet-memory \
  --commit <PINNED_SHA> \
  --profile fresh-chat-bootstrap \
  --entrypoint experiments/fresh-chat-bootstrap/snapshot.mjs \
  --file package.json \
  --file experiments/fresh-chat-bootstrap/snapshot.mjs \
  --file src/memory-library.mjs \
  --file src/memory-artifacts.mjs \
  --file src/memory-events.mjs \
  --file src/memory-views.mjs \
  --file src/memory-bootstrap.mjs \
  --file src/memory-projection.mjs
```

The command prints:
- outer bundle SHA-256;
- repository / exact commit / profile;
- entrypoints;
- every bundled path, byte size, SHA-256 and Git blob SHA-1.

Upload the generated bundle immutably through the ChatGPT Library/file plane, for example:

```text
/anet-memory/v1/source-bundles/<PINNED_SHA>/fresh-chat-bootstrap.mjs
```

Record the exact Library path and outer SHA-256 in #40.

The source bundle must be visible before the consumer run starts.

## 2. Build the dedicated semantic memory root

Use the existing `anet-memoryd` artifact/event API or the repository modules.

The run should contain a small real-task graph rooted at the experiment task.

At minimum the working set should allow the consumer to reconstruct:

- GitHub is source of truth and live repository state must be re-checked;
- persistent ANet is long-term memory; chat context is disposable working memory;
- current bootstrap excludes rejected/superseded history by default;
- #26 endurance run must not be touched;
- the current next action is the real fresh-chat acceptance check.

## 3. Export exact ANet Library objects

Example:

```bash
node experiments/fresh-chat-bootstrap/snapshot.mjs export \
  --memory-root /tmp/anet-fresh-publisher/memory \
  --out /tmp/anet-fresh-bundle \
  --manifest-id <RUN_ID> \
  --project anet-memory \
  --root-artifact <ROOT_TASK_ID> \
  --provenance github:issue/40 \
  --provenance github:commit/<PINNED_SHA>
```

The command fails rather than overwriting an existing output bundle.

It prints:
- every local object path;
- exact target Library path;
- SHA-256;
- manifest path to publish last.

## 4. Publish through the ChatGPT Library tool plane

Upload each artifact/event exactly as bytes to the printed path.

Do not assume the daemon itself can access Library.

After all source-bundle and semantic object uploads are visible, upload the run-specific manifest **LAST**.

Manifest visibility is the semantic snapshot-ready signal. It is not proof of strong Library consistency.

Never overwrite an earlier failed run. Allocate a new manifest/run ID for a rerun.

## 5. Record publisher evidence in #40

Record:
- run ID;
- pinned commit;
- source bundle Library path;
- source bundle outer SHA-256;
- source bundle profile / file count;
- root artifact ID;
- semantic manifest Library path;
- semantic manifest SHA-256;
- object count;
- object path + SHA list (or attach the export plan);
- publication result.

Then hand the consumer only the repository + run/manifest/source-bundle locators. Do not provide a semantic handoff.
