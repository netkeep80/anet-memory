# E1 — repo bootstrap discovery

Owner: [#81](https://github.com/netkeep80/anet-memory/issues/81)  
Parent research: [#79](https://github.com/netkeep80/anet-memory/issues/79)  
Status: **PREPARED / BLIND CONSUMER NOT RUN YET**

## Question

Can a genuinely fresh ChatGPT consumer start from only the repository identity:

```text
netkeep80/anet-memory
```

and discover enough repo-local information to recover the current bounded ANet project context without a manually written connection handoff?

## Candidate under test

The repository advertises:

```text
.anet/memory.json
```

This file is intentionally tiny and non-normative. It is a locator/startup hint, not an accepted ANet wire schema.

The candidate contains only:

- project identity;
- architecture/protocol locator;
- project memory locator;
- a short natural-language startup policy.

No Library `file_id`, size, SHA-256, snapshot generation, role enum, workflow state, capability matrix or message schema is embedded in the bootstrap.

## Blind consumer input

The fresh consumer must not receive before its own semantic verdict:

- prior chat transcript or handoff;
- issue #79 number as an instruction;
- snapshot Library path;
- summary/detail `file_id`;
- expected SHA-256;
- winner/generation answer;
- precomputed current project state.

The only project-specific seed is the repository identity.

## Expected discovery chain

```text
repository identity
  -> ordinary GitHub repository inspection
  -> README bootstrap pointer
  -> .anet/memory.json
  -> project memory locator
  -> latest hierarchical context snapshot pointer
  -> exact summary.json descriptor
  -> materialize exact summary bytes
  -> verify size + SHA-256
  -> bounded project context
  -> ARCHITECTURE.md + live GitHub authority check
```

The consumer should load deeper context only if its actual task cannot be resolved from the summary plus authoritative GitHub state.

## Required evidence

Record at least:

- live `main` resolved independently;
- open PR count resolved independently;
- path by which the bootstrap was discovered;
- exact bootstrap bytes or blob identity;
- snapshot comment/pointer selected from GitHub;
- summary `file_id`, expected size and expected SHA-256;
- independently materialized size and SHA-256;
- whether `detail.json` was read;
- semantic next-work conclusion;
- whether any forbidden handoff data was supplied.

## PASS

```text
PASS_REPO_IDENTITY_TO_BOUNDED_CONTEXT
```

requires all of:

1. repository identity was sufficient to discover the bootstrap;
2. bootstrap was sufficient to locate project memory;
3. exact current summary object was reached without Library-wide guessing;
4. summary bytes matched GitHub-published size/SHA-256;
5. consumer did not need a manually supplied issue/file_id/hash handoff;
6. consumer kept GitHub as authority;
7. `detail.json` was not required merely to determine current next work.

## FAIL / falsifiers

Classify FAIL if:

- the consumer cannot find the bootstrap from ordinary repository inspection;
- a human must provide the memory issue, Library path, file_id or hash;
- Library list/search is needed to guess which object belongs to the project;
- the bootstrap is ambiguous about where project memory lives;
- the snapshot is treated as source of truth;
- deeper context is always required before useful work can begin;
- E1 requires adding substantial protocol machinery rather than a tiny locator.

## Interpretation boundary

A PASS proves only that this candidate is sufficient for the tested discovery path.

It does **not** establish:

- a permanent `.anet/memory.json` schema;
- cross-project namespace rules;
- general Library consistency;
- server-side GitHub non-rewind;
- a fixed agent-role or workflow protocol.

Any field added to a future bootstrap must still pass the #79 minimality test.
