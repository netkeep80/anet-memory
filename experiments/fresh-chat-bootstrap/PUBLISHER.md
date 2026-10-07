# Publisher runbook — fresh-chat bootstrap

Run owner: #40

## Preconditions

- Work from the exact pinned commit recorded for the run.
- Use a **dedicated** local memory root for this experiment.
- Do not copy a raw chat transcript into semantic artifacts.
- Encode only:
  - user-accepted decisions/instructions as author-accepted lifecycle;
  - externally observed GitHub/test evidence as observed/verified lifecycle;
  - model-generated interpretations as proposals unless the user explicitly accepted them.

## 1. Build the dedicated semantic memory root

Use the existing `anet-memoryd` artifact/event API or the repository modules.

The run `fresh-bootstrap-20261007-01` should contain a small real-task graph rooted at the experiment task.

At minimum the working set should allow the consumer to reconstruct:

- GitHub is source of truth and live repository state must be re-checked;
- persistent ANet is long-term memory; chat context is disposable working memory;
- current bootstrap excludes rejected/superseded history by default;
- #26 endurance run must not be touched;
- the current next action is the real fresh-chat acceptance check.

## 2. Export exact Library objects

Example:

```bash
node experiments/fresh-chat-bootstrap/snapshot.mjs export \
  --memory-root /tmp/anet-fresh-publisher/memory \
  --out /tmp/anet-fresh-bundle \
  --manifest-id fresh-bootstrap-20261007-01 \
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

## 3. Publish through the ChatGPT Library tool plane

Upload each artifact/event exactly as bytes to the printed path.

Do not assume the daemon itself can access Library.

After all object uploads are visible, upload:

```text
/anet-memory/v1/manifests/fresh-bootstrap-20261007-01.json
```

**last**.

Manifest visibility is the run's snapshot-ready signal. It is not proof of strong Library consistency.

## 4. Record publisher evidence in #40

Record:
- pinned commit;
- root artifact ID;
- manifest Library path;
- manifest SHA-256;
- object count;
- object path + SHA list (or attach the export plan);
- publication result.

Then hand the consumer only the repository + run/manifest locator. Do not provide a semantic handoff.
