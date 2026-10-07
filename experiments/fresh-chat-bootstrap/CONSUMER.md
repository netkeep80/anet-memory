# Consumer runbook — genuinely fresh chat

Run owner: #40

You are the **consumer** in a controlled fresh-chat acceptance test.

You must not rely on a publisher transcript or a manually written project handoff.

## 1. Establish repository/run identity

Through connected GitHub, independently read:

- issue `netkeep80/anet-memory#40`;
- this README;
- this consumer runbook;

at the exact pinned commit recorded by the publisher.

Do not treat the user's short launch instruction as project state.

## 2. Locate the persistent ANet snapshot

Through ChatGPT Library, locate exactly:

```text
/anet-memory/v1/manifests/fresh-bootstrap-20261007-01.json
```

Read the manifest, then locate/materialize **only** the artifact/event objects explicitly listed there.

Do not infer a missing object is deleted merely because a directory listing is incomplete.

## 3. Verify/import into an empty disposable root

Arrange the materialized objects beneath a local bundle root:

```text
<BUNDLE>/artifacts/<artifact_id>.json
<BUNDLE>/events/<event_id>.json
<BUNDLE>/manifests/fresh-bootstrap-20261007-01.json
```

Then run:

```bash
node experiments/fresh-chat-bootstrap/snapshot.mjs import \
  --memory-root /tmp/anet-fresh-consumer/memory \
  --bundle-root <BUNDLE> \
  --manifest <BUNDLE>/manifests/fresh-bootstrap-20261007-01.json
```

Any missing object, wrong path/logical ID, protocol mismatch or SHA mismatch is FAIL-CLOSED. Do not repair the snapshot by guessing.

## 4. Run bounded BOOTSTRAP

Use the manifest's root artifact ID(s), project and the real task wording from the root semantic artifact.

Example:

```bash
node experiments/fresh-chat-bootstrap/snapshot.mjs bootstrap \
  --memory-root /tmp/anet-fresh-consumer/memory \
  --project anet-memory \
  --task "<TASK FROM PERSISTENT MEMORY>" \
  --root-artifact <ROOT_TASK_ID> \
  --max-nodes 12 \
  --max-bytes 12000 \
  --max-depth 3
```

Do not request historical mode for the current-state acceptance step.

## 5. Independently verify live GitHub

The snapshot contains evidence/provenance, but GitHub is live source of truth.

Independently check:
- exact current `main` HEAD;
- open PRs;
- current CI;
- relevant open issues.

If GitHub moved since snapshot publication, report the discrepancy and update your working conclusion from live GitHub. Do not silently rewrite the imported snapshot.

## 6. Safety boundary

Do not interact with, publish to, restart or mutate the running #26 endurance run:

```text
endurance-20261007-01
```

## 7. Report in #40

Report:
- manifest ID/path;
- import verification result;
- bootstrap node/byte budget usage;
- reconstructed current task;
- accepted constraints/decisions;
- relevant evidence/provenance;
- independently observed live GitHub state;
- next executable action;
- PASS/FAIL against #40.

A correct answer reached by using a hidden/manual handoff is not a PASS.
