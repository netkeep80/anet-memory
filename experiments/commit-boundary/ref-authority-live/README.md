# Live Git ref authority probe — CAS serialization vs non-rewind authority

Status: **RESEARCH ONLY / NO EXTERNAL EFFECTS**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)

## Question

Can a GitHub branch ref be the globally serialized, non-clonable authority that ANet Memory still needs after the stale-selector containment result in #67?

This live experiment separates two properties that are easy to conflate:

1. **serialization / compare-and-swap** — competing writers should not both advance from the same expected head;
2. **non-rewind authority** — after a head is committed, the same effective writer capability must not be able to move it backward or replace history.

The experiment used only disposable research refs. `main`, production source, accepted `sandbox-bus/1`, #26 and #52 were not modified.

## Candidate graph

Base:

`4ce6ce451ac0ee758941dc0a192c7aecbaf55b81`

Candidate A:

`efd86f71e5d5e333e8acb451d7eda05d8aedc4bf`

with parent exactly the base.

Candidate B:

`f8d09e417270f7e033f9398d12bb622ba4ed3f81`

with parent exactly A.

Both commits write the same research claim path and both claim the same logical `lease-1` from the same expected base. B being a child of A is intentional: if A wins first, `A -> B` is still a valid fast-forward. Therefore a later rejection of B with stale `expected_sha=base` cannot be explained only by non-fast-forward ancestry.

## Concurrent race observations

Eight disposable refs were created at the same base and received paired competing `update_ref(... expected_sha=base, force=false)` submissions.

Observed final heads:

```
01 A
02 B
03 A
04 B
05 A
06 B
07 A
08 B
```

The orchestration harness lost the individual first-race call results when its initial branch-read path was rejected, so this artifact deliberately does **not** claim an exact one-success/one-error count for those first paired calls.

Instead, the stronger follow-up was run on the four A-headed refs.

## Stale expected-head fast-forward test

On refs 01, 03, 05 and 07:

- current head = A;
- target = B;
- B is a direct child of A, so the transition itself is fast-forward;
- supplied `expected_sha` remained the original base;
- `force=false`.

All 4 attempts were rejected by the GitHub connector with a generic GraphQL `UNKNOWN` error, and independent ref reads showed head remained A in every case.

Classification:

`PASS_OBSERVED_STALE_EXPECTED_HEAD_FENCING_4_OF_4`

Important limitation: the connector still does not surface a clean stable expected-head conflict error contract. This is observed fencing behavior, not a proven HA CAS SLA.

## Controlled rewind falsifier

On ref 01, starting from A:

### Non-force rewind

`A -> base`, `expected_sha=A`, `force=false`

GitHub rejected the update with:

`rejecting non-fast forward update`

and head remained A.

### Force-with-lease rewind

The same target and same expected current head were then submitted with:

`force=true`

GitHub returned `success:true`, and an independent ref read showed the branch had moved backward from A to the base.

The branch was then restored with an ordinary fast-forward `base -> A`, `force=false`, which succeeded.

This is a direct live falsifier of non-rewind authority under the currently available credential and repository governance.

## Repository governance observation

The live repository rulesets collection returned:

```json
[]
```

No server-side rule was observed that prevents the connected writer capability from force-rewriting these refs.

## Result

Two distinct conclusions are required.

### What Git ref currently appears useful for

A commit SHA plus `expected_sha` is a substantially stronger generation token than a content/blob SHA:

- commit ancestry preserves history identity;
- stale expected-head updates were repeatedly rejected;
- a disciplined `force=false` client can use the ref as a shared global CAS register.

### What it cannot currently be called

The same effective connected writer capability can also submit `force=true` and successfully rewind a disposable ref when it knows the current head.

Therefore, in the current repository configuration:

`Git ref CAS != non-rewind authority`

and:

`shared GitHub write credential != designated writer identity`.

Classification:

- `EXPECTED_HEAD_FENCING_OBSERVED = true`
- `NON_REWIND_AUTHORITY = false`
- `DESIGNATED_WRITER_AUTHENTICATION = false`
- `PRODUCTION_EFFECT_AUTHORITY = false`
- `EXTERNAL_EFFECTS_ALLOWED = false`

## Architectural consequence

GitHub ref CAS can remain a **transport/control-plane serialization primitive**, but must not be the root authority for irreversible effects unless server-side governance removes the rewrite capability from the actors that may execute those effects.

A viable GitHub-based authority would require, at minimum:

- a dedicated protected ref/tag namespace;
- server-side prevention of force-push and deletion for ChatGPT execution principals;
- independently verified permissions showing executors cannot bypass that protection;
- a clean conflict/retry contract for concurrent writers;
- separation between the principal allowed to advance authority and the principal merely allowed to consume it.

The pending GitHub Immutable Release probe remains relevant because it may supply a stronger write-once selector than a mutable branch ref.

For an actual globally shared effect sink, a remote transactional database remains the more direct candidate. A Supabase/PostgreSQL integration is available for a future live cross-sandbox experiment; no such external store is connected or claimed by this artifact.
