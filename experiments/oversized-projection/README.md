# Oversized relation-native projection benchmark

Owner: #49  
Parent completion gate: #5

This benchmark tests whether a fresh ChatGPT worker can solve a task from bounded relation-native `A_q` while the complete persistent ANet corpus is much larger than the supplied projection budget.

## Trust / leakage model

The benchmark has two independent immutable inputs:

```text
consumer source bundle
  exact pinned repository projection/import runtime

semantic benchmark snapshot
  opaque run-specific answer + large distractor corpus
```

The semantic fixture builder is **not included** in the consumer source bundle.

The run-specific plaintext answer is not recorded in the issue, runbook, publisher evidence or source-bundle metadata. Publisher evidence records only:

```text
SHA256({"evidence_token":"...","verdict":"..."})
```

The fresh consumer must derive both fields from the selected bounded projection.

Do not inspect `experiments/oversized-projection/prepare.mjs` or raw semantic object contents during consumer acceptance. The benchmark answer must come through the repository-owned projection interface.

## Corpus shape

The authoritative structural branch is:

```text
TASK
  depends_on -> OLD_DECISION (SUPERSEDED -> CURRENT_DECISION)
  depends_on -> REJECTED_ALTERNATIVE (REJECTED)

CURRENT_DECISION
  evidence -> CURRENT_EVIDENCE
```

The same corpus also contains dozens of disconnected accepted notes with the same query vocabulary and plausible verdict/token text.

If retrieval silently collapses to text similarity, those distractors are deliberately dangerous.

## Budget

Consumer query budget:

```text
max_nodes = 8
max_bytes = 8000
relation_types = depends_on,evidence
```

The authoritative GitHub Actions benchmark generator requires:

```text
exact semantic corpus bytes >= 10 * 8000
```

before it will publish a benchmark artifact.

## Two-stage query

### Stage 1 — shallow

```text
max_depth = 0
```

Only the root task may be selected. The structurally resolved current decision must appear in `frontier`. The answer markers must not appear in selected nodes.

The consumer must explicitly conclude that the projection is insufficient and expand rather than guess.

### Stage 2 — expanded

```text
max_depth = 2
```

Expected structural result:

```text
TASK
CURRENT_DECISION
CURRENT_EVIDENCE
```

No `noise-*` artifact may be selected.

## Determinism / two consumers

Two genuinely fresh consumers run the same immutable manifest and exact query.

Each hashes the exact literal CLI stdout for shallow and expanded projection.

PASS requires the two expanded projection SHA-256 values to be identical and the derived answer commitments to match the publisher commitment.

See `PUBLISHER.md` and `CONSUMER.md`.