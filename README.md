# ANet Memory

Relation-native persistent memory and bounded context projection for AI agents, with FORMAL/JSON interchange and pluggable transport backends.

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

```text
AI chat / agent
      |
      v
bounded context projection
      |
      v
persistent ANet memory
      |
      v
transport / storage adapters
```

The first experimentally proven cross-chat transport is ChatGPT Library: two isolated Kata execution sandboxes exchanged byte-identical files through Library upload -> lookup -> materialize while direct sandbox-to-sandbox networking remained unavailable.

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
