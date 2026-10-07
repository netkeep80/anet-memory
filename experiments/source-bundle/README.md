# Immutable repository source bundle

Owner: #36  
Cross-experiment consumer: #40 / #6

This directory provides a repository-owned way to move the exact executable source for a pinned commit into a disposable Kata without requiring:

- guest network access to GitHub;
- a Git checkout in the consumer;
- a GitHub connector repository/archive materialization primitive;
- npm dependencies.

## Format

Generated artifact:

```text
anet-memory/source-bundle/1
```

The bundle is one self-contained Node `.mjs` file.

It embeds:

- repository identity;
- exact 40-hex commit SHA;
- profile name;
- Node engine requirement;
- entrypoint paths;
- exact source bytes as canonical base64;
- byte size;
- SHA-256;
- Git blob SHA-1 for every embedded file.

The generated file itself supports:

```bash
node source-bundle.mjs verify \
  --repository netkeep80/anet-memory \
  --commit <PINNED_SHA> \
  --profile <PROFILE>

node source-bundle.mjs unpack \
  --out /tmp/anet-source \
  --repository netkeep80/anet-memory \
  --commit <PINNED_SHA> \
  --profile <PROFILE>
```

`unpack` verifies the complete embedded payload before creating the output checkout. The target path must not already exist. Files are written to a staging directory, re-hashed, then renamed into place.

## Outer integrity boundary

The bundle validates its embedded source bytes, but the consumer must also verify the **outer bundle SHA-256 before executing it**.

Publisher evidence therefore records:

```text
Library path
bundle SHA-256
repository
commit SHA
profile
```

The outer hash prevents a tampered bundle from replacing its own verifier.

## Building from an exact checkout

Example:

```bash
node experiments/source-bundle/source-bundle.mjs build \
  --root . \
  --out /tmp/anet-memory-source-bundle.mjs \
  --repository netkeep80/anet-memory \
  --commit <PINNED_SHA> \
  --profile fresh-chat-bootstrap \
  --entrypoint experiments/fresh-chat-bootstrap/snapshot.mjs \
  --file package.json \
  --file experiments/fresh-chat-bootstrap/snapshot.mjs \
  --file src/memory-library.mjs \
  --file src/memory-artifacts.mjs \
  --file src/memory-events.mjs \
  --file src/memory-views.mjs \
  --file src/memory-bootstrap.mjs \
  --file src/memory-projection.mjs
```

The build command prints:

- outer bundle SHA-256;
- source file count/bytes;
- per-file SHA-256;
- per-file Git blob SHA-1.

The Git blob identities can be compared against the pinned GitHub commit independently.

## Fresh-chat acceptance flow

For #40 / #6:

```text
publisher exact checkout
  -> build one fresh-chat source bundle
  -> publish bundle to Library
  -> publish semantic ANet snapshot

fresh consumer
  -> materialize source bundle
  -> verify outer SHA before execution
  -> bundle verify
  -> bundle unpack
  -> execute bundled snapshot.mjs import
  -> execute bundled snapshot.mjs bootstrap
  -> independently verify live GitHub
```

The semantic ANet snapshot remains separate from executable source transport.

## Endurance use

The same format is intentionally generic. #36 can build another profile containing the endurance entrypoint and its transitive runtime files. No change to `sandbox-bus/1` semantics is required.
