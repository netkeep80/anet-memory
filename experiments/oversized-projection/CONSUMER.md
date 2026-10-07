# Consumer runbook — oversized projection benchmark

Owner: #49

You are a genuinely fresh benchmark consumer.

Do not use:
- semantic handoff;
- publisher transcript;
- raw object inspection;
- fixture-builder source;
- manually reconstructed repository code;
- an answer obtained outside the bounded projection.

## 1. Establish run identity

Read independently at the exact publisher-pinned commit:
- issue #49;
- this README;
- this consumer runbook.

Read publisher evidence only for immutable locators/hashes, budgets and answer commitment.

Do not read `experiments/oversized-projection/prepare.mjs` during acceptance.

## 2. Verify executable source before execution

Materialize:

```text
/anet-memory/v1/source-bundles/<PINNED_SHA>/oversized-projection.mjs
```

Before executing:
1. compute outer SHA-256;
2. require exact publisher match.

Run literal bundle `verify` with:

```text
repository = netkeep80/anet-memory
commit = <PINNED_SHA>
profile = oversized-projection
```

Independently compare every reported Git blob SHA-1 with the same path at the pinned GitHub commit.

Unpack into a new previously non-existent Kata path.

## 3. Materialize exact persistent corpus

Materialize the run manifest from Library and verify its SHA-256.

Materialize **only** the artifact/event objects named by the manifest.

For each object:
- verify SHA-256 against the manifest;
- record exact byte size;
- do not inspect semantic plaintext manually.

Compute:

```text
corpus_bytes = sum(exact byte length of every manifest-referenced artifact/event)
```

Require:

```text
corpus_bytes == publisher evidence
corpus_bytes >= 80000
corpus_bytes / 8000 >= 10
```

## 4. Literal import

Lay the already verified bytes into the repository-defined local bundle layout and execute literal bundled:

```bash
snapshot.mjs import
```

against a new empty memory root.

Require all manifest objects imported with no missing/dangling/invalid/conflict state.

## 5. Stage 1 — deliberately insufficient projection

Run literal bundled:

```bash
snapshot.mjs project \
  --memory-root <ROOT> \
  --project anet-memory-oversized-benchmark \
  --seed-artifact <RUN_ID>-task \
  --relation-type depends_on \
  --relation-type evidence \
  --max-nodes 8 \
  --max-bytes 8000 \
  --max-depth 0
```

Save exact stdout bytes and compute `shallow_projection_sha256`.

Require:
- selected nodes = root task only;
- frontier contains `<RUN_ID>-d-current`;
- redirect `<RUN_ID>-d-old -> <RUN_ID>-d-current` is explicit;
- rejected branch is `HISTORICAL_EXCLUDED`;
- selected node summaries contain neither `AUTHORITATIVE_VERDICT=` nor `AUTHORITATIVE_EVIDENCE_TOKEN=`.

Then explicitly state:

```text
INSUFFICIENT_PROJECTION — expansion required
```

Do not guess the answer.

## 6. Stage 2 — bounded structural expansion

Repeat the exact same query with:

```text
max_depth = 2
```

Save exact stdout bytes and compute `expanded_projection_sha256`.

Require:
- selected IDs are exactly TASK, current decision, current evidence;
- zero `noise-*` selected nodes;
- used_nodes <= 8;
- used_bytes <= 8000;
- no unexpected frontier, budget omissions or unresolved omissions.

## 7. Derive answer only from selected A_q

From the current decision summary extract:

```text
AUTHORITATIVE_VERDICT=<value>
```

From current evidence summary extract:

```text
AUTHORITATIVE_EVIDENCE_TOKEN=<value>
```

Canonicalize exactly as:

```json
{"evidence_token":"<value>","verdict":"<value>"}
```

Compute SHA-256 of those exact UTF-8 bytes.

Require exact equality with publisher `answer_commitment_sha256`.

Record the plaintext answer only in your consumer evidence after deriving it from A_q.

## 8. Live GitHub reconciliation

Independently check:
- current main HEAD;
- open PRs;
- CI;
- Source bundle workflow;
- Oversized projection benchmark workflow;
- issue states #49 and #5.

If live main moved, report drift; do not silently rewrite the pinned benchmark.

## 9. Report

Post to #49 with your assigned role (`consumer-a` or `consumer-b`):
- source/semantic integrity;
- exact `corpus_bytes` and ratio;
- shallow projection SHA + selected IDs/frontier;
- explicit insufficient-projection conclusion;
- expanded projection SHA + selected IDs/budget;
- derived plaintext verdict/evidence token;
- derived answer commitment;
- live GitHub state;
- PASS/FAIL.

Do not close #5 after only one consumer. Final acceptance requires both fresh consumers and cross-consumer hash comparison.