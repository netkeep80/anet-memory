# ANet Memory — current architecture direction

Status: **accepted research direction; protocol details remain experimental**  
Primary tracking issue: [#79](https://github.com/netkeep80/anet-memory/issues/79)

## 1. Purpose

ANet Memory is not a system for keeping one enormous chat alive.

Its purpose is to let disposable ChatGPT sessions continue work across many projects while loading only the smallest useful context.

The common operating pattern is:

- one primary working thread owns the detailed work for a project;
- other threads may temporarily audit, research or assist;
- a separate shallow-context thread may coordinate several projects;
- none of those behavioral roles are hard-coded into the protocol.

The durable system must preserve useful knowledge, references, files and inter-session communication without requiring transcript replay.

## 2. Minimal target architecture

```text
GitHub
  control plane / repository authority / source of truth
        |
        | repo-local bootstrap + generation/root selection
        v
ChatGPT Library
  durable JSON/files data plane
        |
        v
disposable ChatGPT sessions
  bounded working context
```

Current target constraints:

- no PostgreSQL, Supabase, Redis or other third-party transactional database;
- no daemon or SQLite database is semantic authority;
- local sandboxes are disposable;
- GitHub server-side non-rewind hardening is explicitly deferred;
- Library discovery/list completeness is not an authority primitive;
- exact selected `file_id` + byte metadata may be used when exact object identity matters.

The fresh-chat GitHub -> Library reconstruction path is experimentally proven in #78. The E1-E5 research series in #79 is now functionally complete: repo bootstrap discovery, three-chat continuation, hypermedia lazy traversal, semantic checkpointing and dynamic orchestration all have bounded PASS evidence. Strict blind isolation remains separately classified where it was not established.

## 3. Multi-project memory

ANet should expose a very small global view first:

```text
global summary
  |
  +-- project A summary
  +-- project B summary
  +-- project C summary
```

A project is then progressively disclosed:

```text
project summary
  -> topic / note summary
    -> full note
      -> evidence
      -> external resource
      -> attachment
```

The system should optimize for the question:

> What is the smallest amount of memory GPT needs to read before it can decide what to read next?

A new chat should not receive all project notes by default.

## 4. Progressive disclosure

Every durable item should support a cheap top-level representation and a deeper representation when needed.

The exact schema is not accepted yet, but the conceptual pattern is:

```text
short summary
   |
   +-- optional fuller content
   |
   +-- references to related memory
   |
   +-- references to evidence / files / URLs
```

GPT chooses traversal depth dynamically from the current task.

Examples:

- “what is the current state of anet-memory?” should require only the project summary and current priorities;
- “why was SQLite rejected as authority?” may open an architecture note and related experiments;
- “prove the fresh-chat replay result” may descend all the way to Git commits, exact Library object metadata and hashes.

Context budgeting is therefore structural rather than transcript-size based.

## 5. Durable knowledge vs conversation

A chat transcript is working context, not canonical memory.

The preferred flow is:

```text
conversation / tool activity
        |
        v
candidate observations
        |
        v
curation
        |
        +-- useful durable note
        +-- useful message
        +-- summary update
        `-- nothing durable
```

ANet should not automatically preserve every chat message as durable knowledge.

Useful durable memory includes things such as:

- decisions;
- requirements;
- experiment results;
- important observations;
- hypotheses;
- unresolved questions;
- references;
- project state summaries;
- important external files or URLs.

These are semantic categories, not necessarily mandatory wire-level enums.

## 6. Hypermedia memory

Notes may refer to:

- other notes;
- GitHub issues, PRs and commits;
- external URLs;
- Library attachments;
- other projects.

Large files should normally remain separate durable objects rather than being embedded into every note.

Where byte identity matters, a reference may carry:

- exact `file_id`;
- size;
- SHA-256;
- human filename / MIME metadata.

A note may remain human-readable Markdown while machine-usable references are kept separately.

## 7. Repository bootstrap

An ANet-enabled project should advertise its memory binding from its own GitHub repository.

Candidate location:

`.anet/memory.json`

The bootstrap should stay tiny. It needs only enough information for a fresh chat to discover:

- project identity;
- ANet protocol/version locator;
- project memory namespace / authority locator;
- initial bounded projection policy.

The project should **not** need to vendor or submodule the entire `anet-memory` repository.

Conceptually:

```text
fresh chat
  -> GitHub project repository
  -> .anet/memory.json
  -> ANet protocol locator
  -> project authority/root
  -> small project summary
  -> lazy traversal as required
```

The current `.anet/memory.json` candidate passed the E1 repo-identity bootstrap experiment, but remains deliberately non-normative: the experiment validates the discovery behavior, not a frozen universal schema.

## 8. Communication between sessions

ANet needs communication, but it should behave more like a very small message bus than a workflow engine.

The core conceptual message is only:

```text
identity
from
to
short content / summary
references
```

Everything else should remain optional until evidence proves it necessary.

A message can naturally mean:

- request;
- result;
- finding;
- status;
- question;
- proposal;
- warning;
- decision;
- handoff.

Those meanings should normally be expressed in natural language rather than a closed mandatory enum.

Short messages should point to memory references rather than copying large context payloads.

## 9. Dynamic roles, not fixed agent classes

ANet must not hard-code roles such as:

- DIRECTOR;
- WORKER;
- AUDITOR.

Those are useful examples only.

A session behaves as a “director” when it happens to:

- observe multiple project summaries;
- use a small context budget;
- send high-level requests;
- avoid implementation detail.

A session behaves as a deep project worker when it happens to:

- focus on one project;
- follow detailed memory references;
- modify the repository;
- retain detailed project working context.

A session behaves as an auditor when its current instruction is to inspect independently and report findings without taking ownership.

The role is therefore dynamically composed from ordinary instructions, current scope and references.

No role state machine is required in the core protocol.

## 10. Shallow orchestration pattern

The E5 experiment demonstrated the following useful pattern without requiring fixed protocol roles:

```text
shallow coordinating session
        |
        | short message + references
        v
deep project session
        |
        | short result / blocker + references
        v
shallow coordinating session
```

The coordinator should not have to load source code, large logs or detailed experiment history unless an escalation actually requires it.

The project session should resolve missing detail from its own repository bootstrap and project memory rather than receiving giant task messages.

This pattern is optional and dynamically constructed; it is not a mandatory topology.

## 11. Session supervision and memory checkpoints

E4 demonstrated that a disposable semantic checkpoint trigger can reliably prompt GPT to consider memory maintenance without becoming semantic authority. Production scheduling, overlap and fencing remain separate engineering concerns in #52.

Possible first implementation:

- disposable daemon;
- CLI;
- tool wrapper;
- repository hook;
- future plugin.

The implementation is secondary. The logical function is:

1. observe that potentially meaningful work occurred;
2. nudge GPT to inspect whether durable knowledge or communication should be emitted;
3. require an explicit semantic decision:
   - memory/message updated; or
   - nothing durable to record.

Useful checkpoint triggers may include:

- PR merge;
- issue closure;
- experiment PASS/FAIL;
- architecture decision;
- new requirement;
- significant audit finding;
- new external reference or attachment;
- handoff;
- approaching context exhaustion.

The supervisor does **not** decide semantic truth and is not storage authority.

A crash of the supervisor must not invalidate already committed memory.

## 12. Protocol minimalism

Protocol complexity is a first-class failure mode.

GPT spends tokens, reasoning time and error budget on every mandatory field, enum, state machine and validation rule.

Therefore:

> Add a machine-strict field only when omitting it makes identity, addressing, integrity or authority unreliable.

### Hard layer

Likely candidates for strict structure:

- object / message identity where needed;
- project binding / locator;
- references;
- Git authority generation/root metadata;
- exact Library `file_id`, size and SHA-256 when byte identity matters.

### Soft layer

Prefer natural language for:

- role;
- purpose;
- responsibility;
- status;
- explanation;
- decision rationale;
- request/result semantics;
- escalation;
- audit wording;
- workflow expectations.

Do not prematurely standardize:

- large capability matrices;
- fixed agent classes;
- COMMAND / ACK / PROGRESS / RESULT state machines;
- mandatory audit/escalation enums;
- workflow engines;
- large universal JSON envelopes.

Candidate JSON shown in research discussions is illustrative, not normative.

## 13. Minimality test for protocol additions

Before adding a required protocol concept, answer all three:

1. What concrete failure occurs without it?
2. Can natural language + a reference solve the same problem reliably?
3. Has an experiment actually falsified the simpler design?

If the third answer is “no”, keep the simpler design.

Target scale for routine objects should remain small enough that GPT can understand them immediately rather than “operate the protocol”.

## 14. E1-E5 research checkpoint

Tracked by #79.

The architecture sequence has now been exercised end-to-end at the functional level:

- **E1 repo bootstrap discovery — PASS:** a fresh consumer given only `netkeep80/anet-memory` discovered `.anet/memory.json`, followed the bounded pointer and recovered exact selected context.
- **E2 three-chat continuation — PASS:** A -> B -> C durable knowledge continuation worked; strict no-ambient-memory blind isolation was not claimed.
- **E3 hypermedia memory — PASS:** question-dependent traversal selected summary/note/evidence/attachment paths without loading the whole corpus.
- **E4 semantic checkpoint — PASS:** a disposable trigger produced bounded SAVE vs NO_DURABLE_CHANGE decisions while GitHub remained authority.
- **E5 dynamic orchestration — PASS:** shallow and detailed sessions delegated, executed, returned and audited work through short natural-language instructions plus references, with no fixed role enum or workflow state machine.

These results validate the architectural direction, not a universal wire schema. New protocol structure should still require a concrete falsifier before being made mandatory.

## 15. Current architectural boundary

Already demonstrated:

- Library-backed durable exact objects and byte-identity verification;
- GitHub current-generation selection of exact Library objects;
- competing-writer expected-head CAS with a single selected winner in live research runs;
- genuinely fresh-chat reconstruction from current Git authority to exact selected Library bytes;
- repo-local automatic ANet discovery from a repository identity;
- multi-generation A -> B -> C continuation;
- bounded hypermedia/lazy traversal including exact Library attachments;
- semantic checkpointing without making the trigger authoritative;
- dynamic shallow/deep orchestration without fixed agent-role protocol types.

Current explicit limits:

- GitHub server-side non-rewind/delete protection is **not proven and is intentionally deferred**; follow-up hardening is tracked by #87;
- irreversible/exactly-once external effects are **not implied by memory commitment** and remain a separate engineering boundary (#52);
- Library listing/search completeness is not assumed; exact GitHub-selected identity plus byte verification is the supported path;
- strict blind isolation is reported separately per experiment and must not be inferred from functional PASS;
- no platform-wide sandbox lifetime, Library retention or visibility SLA is claimed.

The next work should improve useful multi-project memory behavior and real project adoption rather than add infrastructure or protocol fields unless a new experiment forces them.
