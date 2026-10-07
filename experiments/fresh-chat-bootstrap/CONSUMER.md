# Consumer runbook — genuinely fresh chat

Run owner: #40  
Source transport owner: #36

You are the **consumer** in a controlled fresh-chat acceptance test.

You must not rely on a publisher transcript or a manually written project handoff.

## 1. Establish repository/run identity

Through connected GitHub, independently read:

- issue `netkeep80/anet-memory#40`;
- this README;
- this consumer runbook;

at the exact pinned commit recorded by the publisher.

Do not treat the user's short launch instruction as project state.

## 2. Materialize and verify the pinned executable source bundle

From publisher evidence in #40, obtain:
- source bundle Library path;
- expected outer SHA-256;
- expected repository;
- expected commit;
- expected profile `fresh-chat-bootstrap`.

Materialize exactly that one bundle file into the disposable Kata.

**Before executing it**, compute SHA-256 of the materialized file and require exact equality with publisher evidence.

Then run:

```bash
node <SOURCE_BUNDLE>.mjs verify \
  --repository netkeep80/anet-memory \
  --commit <PINNED_SHA> \
  --profile fresh-chat-bootstrap
```

The verify output includes per-file Git blob SHA-1 identities.

Independently compare the bundled source file blob IDs against the same paths at the pinned GitHub commit. Any mismatch is FAIL-CLOSED.

Then unpack into a path that does not already exist:

```bash
node <SOURCE_BUNDLE>.mjs unpack \
  --out /tmp/anet-fresh-source \
  --repository netkeep80/anet-memory \
  --commit <PINNED_SHA> \
  --profile fresh-chat-bootstrap
```

Do not reconstruct missing source manually. Do not substitute an equivalent reimplementation.

From this point onward the repository-owned executable entrypoint is:

```text
/tmp/anet-fresh-source/experiments/fresh-chat-bootstrap/snapshot.mjs
```

## 3. Locate the persistent ANet snapshot

Through ChatGPT Library, locate exactly the run-specific semantic manifest recorded by the publisher.

Read the manifest, then locate/materialize **only** the artifact/event objects explicitly listed there.

Do not infer a missing object is deleted merely because a directory listing is incomplete.

## 4. Execute the literal bundled import into an empty disposable root

Arrange the materialized objects beneath a local bundle root:

```text
<BUNDLE>/artifacts/<artifact_id>.json
<BUNDLE>/events/<event_id>.json
<BUNDLE>/manifests/<RUN_ID>.json
```

Then run the **bundled pinned repository CLI**:

```bash
node /tmp/anet-fresh-source/experiments/fresh-chat-bootstrap/snapshot.mjs import \
  --memory-root /tmp/anet-fresh-consumer/memory \
  --bundle-root <BUNDLE> \
  --manifest <BUNDLE>/manifests/<RUN_ID>.json
```

Any missing object, wrong path/logical ID, protocol mismatch or SHA mismatch is FAIL-CLOSED. Do not repair the snapshot by guessing.

## 5. Run the literal bundled bounded BOOTSTRAP

Use the manifest's root artifact ID(s), project and the real task wording from the root semantic artifact.

```bash
node /tmp/anet-fresh-source/experiments/fresh-chat-bootstrap/snapshot.mjs bootstrap \
  --memory-root /tmp/anet-fresh-consumer/memory \
  --project anet-memory \
  --task "<TASK FROM PERSISTENT MEMORY>" \
  --root-artifact <ROOT_TASK_ID> \
  --max-nodes 12 \
  --max-bytes 12000 \
  --max-depth 3
```

Do not request historical mode for the current-state acceptance step.

## 6. Independently verify live GitHub

The snapshot contains evidence/provenance, but GitHub is live source of truth.

Independently check:
- exact current `main` HEAD;
- open PRs;
- current CI;
- relevant open issues.

If GitHub moved since snapshot publication, report the discrepancy and update your working conclusion from live GitHub. Do not silently rewrite the imported snapshot.

## 7. Safety boundary

Do not interact with, publish to, restart or mutate the #26 endurance run:

```text
endurance-20261007-01
```

## 8. Report in #40

Report:
- run ID;
- source bundle path + outer SHA verification;
- source bundle repository/commit/profile;
- bundled file Git blob comparison result;
- semantic manifest ID/path;
- literal bundled import result;
- literal bundled bootstrap node/byte budget usage;
- reconstructed current task;
- accepted constraints/decisions;
- relevant evidence/provenance;
- independently observed live GitHub state;
- next executable action;
- PASS/FAIL against #40.

A correct answer reached by hidden/manual handoff, manually reconstructed source, or a separately reimplemented equivalent is not a PASS.
