# Stale selector containment — freshness is not effect authority

Status: **RESEARCH ONLY / SYNTHETIC EFFECTS ONLY**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
Composes the already-merged immutable selector contract (#66) with the authenticated fenced synthetic sink (#63). No production `src/`, accepted `sandbox-bus/1`, #26 or #52 behavior is changed.

## Question

Does safe irreversible-effect execution require a consumer to prove that the selector it reconstructed is globally the **latest** selector?

Under one strong condition, **no**. If every irreversible effect reaches one globally authoritative downstream commit point that atomically authenticates the writer, checks the currently installed generation, and deduplicates the logical effect key, then an authentic-but-stale selector can cause stale reads or loss of liveness but cannot authorize a stale effect. The downstream sink rejects the old generation as `STALE_AUTHORITY`.

This experiment deliberately separates two properties:

- **freshness / liveness** — did the consumer discover the newest selector/state?
- **effect safety** — can this consumer commit an irreversible effect against the currently authoritative generation?

The first may be unknown under incomplete discovery. The second must remain fail-closed at the sink.

## Composed model

The test imports the existing research modules rather than reimplementing their semantics:

- `../immutable-release-selector/selector_contract.py` validates exact selector structure/generation;
- `../fenced-effect-sink/fenced_effect_sink.py` supplies authenticated writer credentials, monotonic generation rotation, sink-side idempotency, and transactional effect receipts.

Scenario:

1. consumer has an assumed-authentic generation-1 selector and old writer credential;
2. the single sink has already rotated to generation 2;
3. generation-1 consumer may perform explicit read-only/reversible computation;
4. its generation-1 effect request reaches the sink and is rejected `STALE_AUTHORITY`;
5. the generation-2 writer can apply the effect and retries deduplicate.

A failed lookup for generation 2 is classified `FRESHNESS_UNKNOWN`, never “generation 1 is current.” Finding generation 2 still does not prove that generation 3 does not exist.

## Required negative controls

The containment result is **conditional**, not universal. Tests preserve two counterexamples:

1. **split-brain sink clone** — clone the generation-1 SQLite sink with copied credentials, advance only the original to generation 2, then the stale consumer successfully applies to the independently writable clone. This retains the #60 lesson: local idempotency/fencing is not global authority.
2. **ungated destination** — a destination that does not check current authority simply performs the stale request. Source/selector correctness cannot retroactively fence an external service that does not participate.

Therefore latest-selector discovery can be demoted from a P0 *effect-safety* prerequisite only when there is exactly one effective downstream authority (or an equivalent globally serialized service) and **all** irreversible effects are forced through it.

## Result classification

Expected positive classification:

`PASS_STALE_SELECTOR_EFFECT_CONTAINMENT_UNDER_SINGLE_FENCING_SINK`

It means only:

- authentic stale state may be used for read-only/reversible work;
- stale generation cannot commit through the current single fenced sink;
- incomplete discovery is a freshness/liveness problem **under that sink assumption**.

It does **not** mean:

- GitHub Immutable Releases have passed their pending live platform probe;
- the stale selector is actually authentic merely because local JSON validates;
- latest generation has been discovered;
- copied sink databases/credentials are safe;
- arbitrary HTTP/email/payment/filesystem APIs are fenced;
- cross-sandbox credential provisioning is solved;
- external effects are enabled.

`external_effects_allowed=false` throughout. #54 stays open and #52 remains effect-disabled.

## Reproduction

```bash
node --test test/stale-selector-containment.test.mjs
```

The Node wrapper runs the Python suite with `ResourceWarning` promoted to error.
