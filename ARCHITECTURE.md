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

The fresh-chat GitHub -> Library reconstruction path is experimentally proven in #78.

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

The concrete bootstrap JSON schema is not accepted until tested.

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

A useful pattern to test is:

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

A local session supervisor may be useful to prevent GPT from finishing important work without considering memory maintenance.

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

## 14. Next experiments

Tracked by #79.

### E1 — repository bootstrap discovery

Give a genuinely fresh chat only a GitHub project repository identity.

It must discover the ANet binding from the repository and recover a bounded project summary without a hand-written connection prompt.

### E2 — three-chat continuation

```text
Chat A
  publishes project memory generation N

fresh Chat B
  discovers/reconstructs N
  adds useful durable knowledge
  publishes N+1

fresh Chat C
  independently discovers/reconstructs N+1
  proves old + new knowledge survived
```

### E3 — hypermedia memory

Include:

- a concise project summary;
- at least one durable note;
- an external URL;
- an exact Library attachment;
- a relation to another note or project object.

The fresh consumer should load only the levels needed by its question.

### E4 — session supervisor checkpoint

Demonstrate that a disposable supervisor reliably causes GPT to consider notes/messages at important semantic transitions without becoming authority or producing excessive noise.

### E5 — dynamic orchestration

Demonstrate a shallow-context coordinating chat directing a deeper project chat using short messages and references.

No fixed DIRECTOR/WORKER protocol types are allowed.

## 15. Current architectural boundary

Already demonstrated:

- Library-backed durable exact objects;
- GitHub current-generation selection;
- competing-writer CAS single-winner behavior;
- genuinely fresh-chat reconstruction from current Git authority to exact selected Library bytes.

Explicitly not yet demonstrated:

- repo-local automatic ANet discovery;
- multi-generation three-chat continuation;
- useful hierarchical note retrieval at scale;
- attachment/reference traversal as project memory;
- reliable memory checkpoints;
- dynamic orchestration through ANet messages;
- different-sandbox classification for the latest fresh consumer;
- server-side GitHub non-rewind, which is deferred.

The next work should improve useful memory behavior rather than add infrastructure unless an experiment forces additional infrastructure.
