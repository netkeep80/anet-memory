# ANet Memory

Persistent multi-project memory, bounded context projection and lightweight inter-session communication for AI agents/chats.

## Core idea

```text
disposable chat / agent
        +
persistent ANet memory
        +
bounded task-specific projection
        =
continuity without transcript accumulation
```

The project treats a chat context as working memory, not as the durable source of truth.

## Architecture

Current target:

```text
GitHub
  control plane / repository authority / source of truth
        |
        v
ChatGPT Library
  durable JSON/files data plane
        |
        v
disposable ChatGPT sessions
  bounded working context
```

The project is moving from transport research toward a **minimal multi-project memory and messaging architecture**:

- repositories advertise their ANet binding through a tiny repo-local bootstrap;
- GPT first loads short global/project summaries and follows references only as needed;
- durable notes may link to other notes, GitHub, external resources and Library attachments;
- sessions may exchange short messages plus references instead of copying large contexts;
- roles such as “director”, “worker” or “auditor” are dynamic behavioral patterns, not protocol types;
- a disposable session supervisor may nudge GPT to checkpoint useful knowledge, but is not storage or semantic authority;
- protocol structure stays strict only for identity, addressing, integrity and authority; semantic meaning prefers natural language.

The current architecture direction and its explicit non-goals are canonicalized in [`ARCHITECTURE.md`](ARCHITECTURE.md) and tracked by [#79](https://github.com/netkeep80/anet-memory/issues/79).

Fresh-chat discovery experiment: [`.anet/memory.json`](.anet/memory.json) is the current **non-normative** repo-local bootstrap candidate tracked by [#81](https://github.com/netkeep80/anet-memory/issues/81).

The first experimentally proven cross-chat transport is ChatGPT Library. Later experiments established GitHub current-generation selection plus exact Library object recovery in a genuinely fresh chat. Historical daemon/SQLite/runtime-topology experiments remain useful falsifier evidence but are not target runtime authority.

## Project authority

- Architecture and invariants: #1
- Roadmap: #10
- Transport protocol: #2
- FORMAL/JSON interchange: #3
- Persistent knowledge model: #4
- Bounded structural projection: #5
- Fresh-chat bootstrap: #6
- Library consistency research: #7
- A-memory/backend abstraction: #8
- Evaluation: #9
- Current multi-project architecture direction: #79 and `ARCHITECTURE.md`
- ChatGPT runtime topology research: #43 and `experiments/runtime-topology/README.md`

This repository does not define a new MTS ontology. FORMAL/MTS semantics remain owned by their upstream specification.

## Governance

The repository uses [repo-guard](https://github.com/netkeep80/repo-guard) in **advisory** mode initially. It will move to blocking only after positive and negative witnesses show that the policy protects a real project boundary without obstructing normal development.


## sandbox-bus/1 reference implementation

The first executable slice lives in `src/sandbox-bus.mjs`. It intentionally has no runtime dependencies.

Transport payloads are exact bytes encoded as Base64 inside the JSON envelope. `payload_sha256` is calculated over the decoded payload bytes, so FORMAL/JSON or any other artifact can later be transferred byte-for-byte without making JSON canonicalization part of the transport contract.

Examples:

```bash
node src/sandbox-bus-cli.mjs create thread-a thread-b 1 null payload.json message.json application/json
node src/sandbox-bus-cli.mjs validate message.json
node src/sandbox-bus-cli.mjs ack thread-b thread-a 1 null <message-id> processed ack.json
node src/sandbox-bus-cli.mjs inspect thread-a thread-b message.json
npm test
```

The filename/path is only a sortable physical index. `message_id`, `sequence`, and `previous_message_id` inside the envelope are authoritative.
