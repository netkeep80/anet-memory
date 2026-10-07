# Fresh-chat bootstrap acceptance experiment

Owner: #40  
Parent acceptance gate: #6

This experiment tests the project claim that a ChatGPT conversation can be disposable working memory while persistent ANet Memory carries the structured long-term state needed by a genuinely fresh chat.

It is deliberately separate from the dual-thread endurance experiment in #26.

## Invariant

Do not read, write, mutate, restart, reuse, or otherwise interfere with:

```text
endurance-20261007-01
```

The fresh-chat experiment uses the ANet Library namespace:

```text
/anet-memory/v1/
```

and run-specific manifest:

```text
fresh-bootstrap-20261007-01
```

## Actors

- **Publisher**: the development chat that creates a small real-task semantic memory snapshot.
- **Consumer**: a genuinely fresh ChatGPT chat with no publisher transcript or manual handoff.

## Trust model

The Library manifest is a snapshot locator, not live GitHub authority.

The consumer must:

1. verify the exact Library object bytes against the manifest;
2. import them into an empty local memory root;
3. run bounded BOOTSTRAP;
4. independently verify current GitHub main / CI / open PR state before acting.

A stale but internally valid snapshot is possible. That is why GitHub remains source of truth for repository state.

## Publisher order

1. Pin the exact repository commit containing this runbook/harness.
2. Create a dedicated local memory root containing only the real task's semantic artifacts/events.
3. Export it with `snapshot.mjs export`.
4. Upload every artifact/event to its exact Library path from the export plan.
5. Upload the manifest **LAST**.
6. Record pinned commit, object hashes and manifest publication in #40.

See [PUBLISHER.md](./PUBLISHER.md).

## Consumer order

1. Independently read #40 and this runbook at the pinned commit.
2. Locate the one run-specific manifest in Library.
3. Materialize exactly the objects named by the manifest.
4. Arrange them under a disposable local bundle root using the manifest-relative `artifacts/` and `events/` paths.
5. Run `snapshot.mjs import` into a new empty local memory root.
6. Run `snapshot.mjs bootstrap` under the run budget.
7. Independently verify current GitHub state.
8. Report reconstructed task/constraints/evidence/next action and PASS/FAIL in #40.

See [CONSUMER.md](./CONSUMER.md).

## Pass

PASS requires that the consumer correctly resumes the real task from bounded persistent ANet Memory plus independent GitHub verification, with no giant handoff or transcript replay.

The code-level tests and a successful import alone are not sufficient to close #6.
