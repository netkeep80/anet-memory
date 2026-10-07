# Fresh-chat bootstrap acceptance experiment

Owner: #40  
Parent acceptance gate: #6  
Pinned source transport: #36

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

Every rerun uses a new immutable run/manifest ID. Failed runs are preserved as evidence and are never overwritten.

## Actors

- **Publisher**: the development chat that creates a small real-task semantic memory snapshot and one immutable executable source bundle for the pinned commit.
- **Consumer**: a genuinely fresh ChatGPT chat with no publisher transcript or manual handoff.

## Trust model

There are two independent durable inputs:

```text
source bundle
  = exact executable pinned repository source

semantic snapshot
  = exact persistent ANet task state
```

Neither is live GitHub authority.

The consumer must:

1. materialize one source bundle;
2. verify its outer SHA-256 **before execution**;
3. self-verify/unpack all embedded source bytes and compare their Git blob identities to the pinned GitHub commit;
4. verify the exact semantic Library object bytes against the semantic manifest;
5. execute the literal bundled `snapshot.mjs import`;
6. execute the literal bundled bounded BOOTSTRAP;
7. independently verify current GitHub main / CI / open PR state before acting.

A stale but internally valid snapshot is possible. That is why GitHub remains source of truth for repository state.

## Publisher order

1. Pin the exact repository commit containing the runbook/harness/source-bundle implementation.
2. Build and publish one immutable `fresh-chat-bootstrap` source bundle; record outer SHA-256.
3. Create a dedicated local memory root containing only the real task's semantic artifacts/events.
4. Export it with `snapshot.mjs export`.
5. Upload every artifact/event to its exact Library path from the export plan.
6. Upload the semantic manifest **LAST**.
7. Record source bundle + semantic snapshot evidence in #40.

See [PUBLISHER.md](./PUBLISHER.md).

## Consumer order

1. Independently read #40 and this runbook at the pinned commit.
2. Materialize one source bundle from publisher evidence.
3. Verify outer SHA before execution, then verify/unpack into an empty Kata directory.
4. Compare bundled Git blob IDs against the pinned commit.
5. Locate the one run-specific semantic manifest in Library.
6. Materialize exactly the semantic objects named by the manifest.
7. Run the literal bundled `snapshot.mjs import` into a new empty local memory root.
8. Run the literal bundled `snapshot.mjs bootstrap` under the run budget.
9. Independently verify current GitHub state.
10. Report reconstructed task/constraints/evidence/next action and PASS/FAIL in #40.

See [CONSUMER.md](./CONSUMER.md).

## Pass

PASS requires that the consumer correctly resumes the real task from:
- the immutable pinned executable source bundle;
- bounded persistent ANet Memory;
- independent live GitHub verification;

with no giant handoff, transcript replay, manual source reconstruction, or equivalent reimplementation.

The code-level tests and a successful import alone are not sufficient to close #6.
