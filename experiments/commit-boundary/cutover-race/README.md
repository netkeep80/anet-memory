# Serialized cutover race — local SQLite authority simulator

Status: **RESEARCH ONLY / NO EXTERNAL EFFECTS**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
Based on prior journal-catchup prototype in `../journal-cutover/`; accepted `sandbox-bus/1` and #26/#52 are **not changed**.

## Question and non-goals

Can we exclude the specific *checkpoint → late old-writer receipt → fence → successor* gap **if** all old-writer receipt appends and the fencing/cut operation are serialized by one transactional authority? This test uses one **local** shared SQLite database with `BEGIN IMMEDIATE`, `WAL`, `synchronous=FULL`, real independent OS worker processes, and a separate **passive** successor SQLite DB. Every event is a *synthetic receipt*, **not an external side effect**.

This does **not** test or assert that GitHub refs supply production CAS, that ChatGPT Library is linearizable, that a Git commit/ref is protected from rewriting, that an arbitrary writer is authenticated, that two clones are globally serialized, or that a local SQLite receipt proves an actual external effect. The model has no Library operations, no network transport, and no authorization or external-effect API.

## Safety model

`record(old)` and `fence()` both acquire **the same** SQLite write transaction. `fence()` atomically changes phase and records a terminal sequence/head. It is *not* implemented as `snapshot; sleep; list Library` or two separate non-atomic actions.

Logical gates, not five independent mutable authorities:

| Predicate / stage | Necessary authority evidence | Effect eligibility |
|---|---|---|
| `CHECKPOINT_SELECTED` | Local checkpoint cursor, chain head and digest | forbidden |
| `OLD_GENERATION_FENCED` | The cut transaction excludes any further old-generation append | forbidden |
| `JOURNAL_HEAD_COMMITTED` | **Same** atomic transaction fixes terminal seq/head | forbidden |
| `CATCHUP_COMPLETE` | Passive successor verifies exact chain from checkpoint through committed terminal | forbidden |
| `SUCCESSOR_PROMOTED` | Authority DB observes exact passive successor catch-up, advances generation 1→2 | **still forbidden for external effects** |

`OLD_GENERATION_FENCED` and `JOURNAL_HEAD_COMMITTED` are one indivisible database commit; the model intentionally has **no** intermediate durable phase with a fence but missing terminal head. The explicit phase in the database moves `ACTIVE → CUT_COMMITTED → SUCCESSOR_PROMOTED` monotonically. `CHECKPOINT_SELECTED` is immutable metadata while phase remains `ACTIVE`; old writes may continue until `CUT_COMMITTED`. The successor remains passive until promotion.

**Linearization invariant:** For any old generation-1 event racing with the cut, exactly one of the following holds:

1. Its `record` transaction commits first: the event is in the terminal prefix and must be replayed during successor catch-up.
2. The cut transaction commits first: `record` rejects with `WRITER_FENCED` and the event cannot appear outside the terminal prefix through this API.

The guarantee applies only to events written through this authority database and this receipt path. If an external effect executes before/without its receipt, or a malicious writer bypasses the DB, it is **outside the model**. In particular, a caller-supplied `generation` is **not authentication**; an explicit passing negative test demonstrates impersonation by anyone with DB access.

## Forbidden transitions (tested)

- fence without a checkpoint; checkpoint twice; fence twice, including ambiguous lost fence ACK;
- premature generation-2 writes before promotion; generation-1 writes after the cut;
- promotion before catch-up; promotion twice; follower mutation or unverified receipt chain;
- terminal hash drift, missing sequence, mismatched checkpoint anchor;
- treating successful local promotion as authorization for external HTTP effects.

## Reproduction

Linux with Python 3 stdlib SQLite and Node >=20:

```bash
node --test test/cutover-race.test.mjs
```

The Node CI wrapper executes a Python unittest suite including 8 **actual simultaneous subprocess** `record`/`fence` races, independent follower verification, crash injected with **real SIGKILL** immediately before COMMIT and after COMMIT before ACK, plus positive and negative safety tests. The race result is allowed to vary, but every observed interleaving must satisfy the recorded-or-fenced dichotomy. An in-memory mock of simultaneous calls would be insufficient for this particular test.

Direct CLI example (all paths must be isolated scratch files):

```bash
python3 cutover_race.py init --db /tmp/cut-source.sqlite
python3 cutover_race.py record --db /tmp/cut-source.sqlite --key base
python3 cutover_race.py checkpoint --db /tmp/cut-source.sqlite
python3 cutover_race.py bootstrap --db /tmp/cut-source.sqlite --follower /tmp/cut-follower.sqlite
python3 cutover_race.py record --db /tmp/cut-source.sqlite --key late
python3 cutover_race.py fence --db /tmp/cut-source.sqlite
python3 cutover_race.py catchup --db /tmp/cut-source.sqlite --follower /tmp/cut-follower.sqlite
python3 cutover_race.py promote --db /tmp/cut-source.sqlite --follower /tmp/cut-follower.sqlite
```

The `checkpoint` here is an immutable *logical ledger prefix* recreated in a separate passive SQLite file. This is **not** a fresh-chat or Library-transported WAL-consistent `sqlite3.backup` (the separate prior experiment handles that). All hashes bind exact canonical JSON receipt rows; no FORMAL interpretation occurs.

## Remaining #54 blockers

1. Replace the **assumed** shared local SQLite serialization with independently verified, authenticated, monotonic **no-rewind/no-force** authority available to genuinely different sandboxes.
2. Prove a genuinely fresh consumer can obtain exact checkpoint and all journal bytes through temporarily incomplete Library discovery, using a trusted immutable terminal selector; do not interpret a single list as complete.
3. Specify and test outstanding/in-flight old-writer **external** actions and whether fence is enforced by the actual downstream effect target. A ledger-only fence does not stop in-flight non-transactional HTTP operations.
4. Provide transactional/idempotent/fencing semantics at downstream target, or explicitly classify at-least-once and compensation. No general exactly-once claim for arbitrary external APIs.
5. Complete existing independent fresh-chat consumer gates (#7 LC-02, #54 Git-selected manifest, #54 portable SQLite snapshot) **in separate chats**.

Classification: `PASS_LOCAL_SERIALIZED_CUTOVER_RACE` conditional on the trusted shared SQLite authority and passive successor assumption; `AUTHENTICATED_DISTRIBUTED_CUTOVER = NOT_PROVEN`; `EXTERNAL_EFFECTS_ALLOWED = false`.
