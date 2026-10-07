# Consumer runbook — history/rationale fresh chat

Owner: #46

You are a genuinely fresh consumer. Do not use a semantic handoff, publisher transcript or manually reconstructed source.

## 1. Establish exact run identity

Independently read:
- issue #46;
- this README;
- this consumer runbook;

at the publisher-pinned commit.

Read publisher evidence in #46 only for immutable locators/hashes and pinned repository evidence.

## 2. Materialize executable pinned source

Materialize exactly the published Library source bundle:

```text
/anet-memory/v1/source-bundles/<PINNED_SHA>/history-rationale.mjs
```

Before executing it:
- compute outer SHA-256;
- require exact match with publisher evidence.

Run literal bundle `verify` with:
- repository `netkeep80/anet-memory`;
- exact pinned commit;
- profile `history-rationale`.

Independently compare every reported Git blob SHA-1 with the same path at the pinned GitHub commit.

Unpack to a new previously non-existent Kata directory.

Any mismatch is FAIL-CLOSED.

## 3. Materialize/import persistent ANet snapshot

Materialize the run manifest:

```text
/anet-memory/v1/manifests/<RUN_ID>.json
```

Verify its SHA-256, then materialize **only** the objects listed by the manifest and verify every object exactly.

Using the unpacked repository-owned CLI, import into a new empty memory root:

```bash
node <UNPACKED>/experiments/fresh-chat-bootstrap/snapshot.mjs import \
  --memory-root /tmp/anet-history-consumer/memory \
  --bundle-root <SEMANTIC_BUNDLE_ROOT> \
  --manifest <SEMANTIC_BUNDLE_ROOT>/manifests/<RUN_ID>.json
```

## 4. Assertion A — current-state pollution resistance

Run:

```bash
node <UNPACKED>/experiments/fresh-chat-bootstrap/snapshot.mjs bootstrap \
  --memory-root /tmp/anet-history-consumer/memory \
  --project anet-memory-history-test \
  --task "fresh-chat pollution resistance and rationale recovery" \
  --root-artifact <RUN_ID>-task \
  --max-nodes 8 \
  --max-bytes 12000 \
  --max-depth 3
```

Require:
- `<RUN_ID>-d2` present;
- `<RUN_ID>-d1` absent from current nodes;
- `<RUN_ID>-r1` absent from current nodes;
- redirect `d1 -> d2` present;
- policy omission for `r1` with `HISTORICAL_EXCLUDED`;
- no historical node presented as current accepted state.

## 5. Assertion B — superseded rationale recovery

Run:

```bash
node <UNPACKED>/experiments/fresh-chat-bootstrap/snapshot.mjs project \
  --memory-root /tmp/anet-history-consumer/memory \
  --project anet-memory-history-test \
  --seed-artifact <RUN_ID>-d1 \
  --relation-type evidence \
  --include-historical true \
  --max-nodes 8 \
  --max-bytes 12000 \
  --max-depth 3
```

Require bounded recovery of:
- D1 / SUPERSEDED;
- E1;
- D2 / ACCEPTED;
- E2;
- provenance.

## 6. Assertion C — rejected rationale recovery

Run:

```bash
node <UNPACKED>/experiments/fresh-chat-bootstrap/snapshot.mjs project \
  --memory-root /tmp/anet-history-consumer/memory \
  --project anet-memory-history-test \
  --seed-artifact <RUN_ID>-r1 \
  --relation-type rejected_by \
  --relation-type evidence \
  --include-historical true \
  --max-nodes 8 \
  --max-bytes 12000 \
  --max-depth 3
```

Require bounded recovery of:
- R1 / REJECTED;
- DR / ACCEPTED;
- ER;
- provenance.

## 7. Independently reconcile GitHub

Check live:
- main HEAD;
- open PRs;
- CI;
- source-bundle workflow;
- #46/#6/#5/#4 state.

Snapshot GitHub evidence is not live authority.

## PASS

PASS only if source integrity, semantic integrity and all three semantic assertions pass from the literal bundled repository implementation.

Record full consumer evidence in #46.

Do not close #5 solely from this run: #5 completion still requires the oversized-corpus benchmark.
