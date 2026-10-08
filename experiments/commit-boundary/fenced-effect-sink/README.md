# Fenced synthetic effect sink — authenticated local research model

Status: **RESEARCH ONLY / SYNTHETIC EFFECTS ONLY**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
The accepted `sandbox-bus/1`, #26 and #52 are not changed.

## Question

The source-side cutover model in `../cutover-race/` can serialize an old writer receipt against a fence, but an already-issued request may still be in flight toward a downstream service. What additional property must the **effect sink itself** provide so that an old request cannot execute after successor authority is installed?

This experiment makes the downstream boundary explicit. A private SQLite database represents a synthetic effect sink. It holds a current `(scope, generation, writer_id)` authority, independent writer credentials, a control-plane credential, a monotonic receipt ledger and idempotency keys. Writer requests and authority rotations are HMAC-authenticated for the research harness. The sink checks the credential **and** current authority inside the same `BEGIN IMMEDIATE` transaction that records the synthetic effect receipt.

No HTTP request, filesystem mutation outside scratch SQLite files, money movement, email, message send, or other real side effect occurs.

## Linearization property

For an authenticated generation-1 request racing with a control-plane rotation from generation 1 to generation 2, both operations serialize on the sink database. Exactly one allowed outcome exists:

1. **effect transaction commits first** — its immutable receipt precedes `AUTHORITY_ROTATED` in the sink ledger; or
2. **rotation commits first** — the old request is rejected `STALE_AUTHORITY`, even when it was signed/issued before the rotation and only entered its transaction afterwards.

There is no allowed ledger ordering `AUTHORITY_ROTATED → EFFECT_APPLIED(generation=1)` through this API.

This answers only a local protocol question: **safe cutover of irreversible effects requires fencing at the point that performs/deduplicates the effect, not merely a source-side generation variable or source receipt.**

## Authentication boundary

Two writer secrets and a distinct control secret are provisioned into the private synthetic sink. Requests are canonical-JSON HMAC-SHA256 signed. The tests reject:

- a writer using the other generation's secret;
- an old writer claiming the successor identity;
- a writer secret attempting to authorize a control-plane rotation;
- non-monotonic or CAS-mismatched authority rotation.

This demonstrates credential checking in the model, **not** production identity. HMAC keys are local test fixtures, not ChatGPT sandbox credentials, GitHub App identities, hardware keys or a deployed secret distribution system. A process that can read or rewrite the sink database is inside the trusted computing base.

## Crash / retry behavior

`WAL` + `synchronous=FULL` and one SQLite transaction bind each synthetic effect receipt or authority rotation. Tests use real subprocess `SIGKILL` failpoints:

- kill before COMMIT: operation rolls back;
- kill after COMMIT before ACK: retry observes durable state;
- effect retry returns `ALREADY_APPLIED` for the same key/payload;
- rotation retry returns `AUTHORITY_ALREADY_INSTALLED` for the exact same control request;
- conflicting payload for an existing effect key fails closed.

## Reproduction

```bash
node --test test/fenced-effect-sink.test.mjs
```

The Node wrapper runs 13 Python tests, including 12 independent databases where separate OS subprocesses race an old authenticated `apply` with an authenticated `rotate`.

## What this proves

Within one private transactional sink:

- writer identity can be checked before accepting a synthetic effect;
- authority generation can be advanced monotonically with CAS semantics;
- an in-flight old request is either durably before the rotation or rejected after it;
- ACK loss does not create a second synthetic effect for the same idempotency key;
- a receipt ledger gives an exact order between accepted effects and authority changes.

## What this does **not** prove

- that ChatGPT Library is a linearizable or complete authority;
- that GitHub refs are protected against force/rewind or constitute production fencing;
- that credentials can be securely provisioned to genuinely different ChatGPT sandboxes;
- that this local SQLite database is remotely reachable or highly available;
- that arbitrary third-party APIs provide atomic authority checking + idempotency;
- that a source journal and an independent external sink can be atomically committed together;
- that a synthetic receipt equals a real-world effect;
- that #54 is accepted or that #52 may perform irreversible external effects.

Most importantly, this experiment deliberately does **not** hide the distributed transaction gap. If the real side effect lives in a service that cannot enforce the generation/idempotency contract at its own commit point, a source-side fence cannot retroactively cancel a request already accepted by that service.

## Next #54 gate

The next useful research step is cross-boundary composition: bind the source terminal cut/journal to a sink authority rotation without assuming an impossible atomic transaction across two independent stores. Candidate protocols to falsify include a durable transactional outbox, sink-issued effect receipts incorporated into the authoritative journal, and a two-phase/lease-style promotion in which the successor remains effect-ineligible until all pre-cut sink receipts are reconciled.
