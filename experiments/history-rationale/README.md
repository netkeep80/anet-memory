# Fresh-chat history/rationale acceptance experiment

Owner: #46  
Verifies: #6 required tests B/C, #5 experiments 6/7, #4 current/history behavior.

This experiment deliberately places superseded and rejected history on paths reachable from the current task.

The test is designed to distinguish:

```text
current-state projection
!=
historical/rationale projection
```

without changing the persistent corpus between the two queries.

## Fixture

The publisher creates one deterministic synthetic acceptance fixture using:

```bash
node experiments/history-rationale/prepare.mjs \
  --memory-root <EMPTY_MEMORY_ROOT> \
  --run-id <RUN_ID>
```

Default fixture project:

```text
anet-memory-history-test
```

Logical shape:

```text
TASK
  depends_on -> D1 (SUPERSEDED -> D2)
  depends_on -> R1 (REJECTED)

D1 --evidence--> E1
D2 --evidence--> E2

R1 --rejected_by--> DR --evidence--> ER
```

The lifecycle corpus is synthetic and scoped to this experiment. It must not be treated as authoritative project decisions outside the fixture.

## Acceptance assertions

### Current state

Literal bundled `snapshot.mjs bootstrap` rooted at TASK must:
- include TASK;
- include D2;
- exclude D1 as a current node;
- exclude R1 as a current node;
- report the D1 -> D2 redirect;
- report R1 as excluded by historical policy.

### Superseded rationale

Literal bundled `snapshot.mjs project` rooted at D1 with:
- `include_historical=true`;
- relation type `evidence`;

must recover:
- D1 with lifecycle SUPERSEDED;
- E1;
- D2 via lifecycle supersession;
- E2.

### Rejected rationale

Literal bundled `snapshot.mjs project` rooted at R1 with:
- `include_historical=true`;
- relation types `rejected_by` and `evidence`;

must recover:
- R1 with lifecycle REJECTED;
- DR;
- ER.

All projections remain bounded and provenance-preserving.

## Trust boundary

The fresh consumer uses:
1. one immutable `history-rationale` source bundle built by GitHub Actions from the pinned commit;
2. one immutable ANet Library semantic manifest and exactly its referenced objects;
3. independent live GitHub verification.

Outer source-bundle SHA-256 is checked before execution. Embedded Git blob IDs are checked against the pinned GitHub commit.

No manual semantic handoff, transcript replay or reconstructed source is a PASS.
