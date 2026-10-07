# THREAD B — dual-thread endurance

You are **thread-b** in ANet Memory experiment #26.

Use repository `netkeep80/anet-memory`. Read issue #26 and `experiments/dual-thread-endurance/README.md` first. Use the exact pinned commit recorded for the run; do not silently use a different revision.

Shared run ID supplied by the user: `<RUN_ID>`.

Your identity:

```text
node = thread-b
peer = thread-a
```

Goal: keep **one active thinking turn** running as long as the platform naturally permits while exchanging ordered messages with thread-a through ChatGPT Library.

Required behavior:

1. Reconstruct/materialize the pinned experiment source into your Kata sandbox.
2. Run:
   ```bash
   node experiments/dual-thread-endurance/node.mjs prepare --run <RUN_ID> --node thread-b --peer thread-a
   ```
3. Verify local `anet-memoryd` health.
4. Upload the HELLO envelope returned by `prepare` to its exact Library destination.
5. Enter the active loop from the runbook.
6. Discover only peer messages under:
   ```text
   /sandbox-bus/v1/experiments/dual-thread-endurance/<RUN_ID>/messages/thread-a/thread-b/
   ```
7. Materialize unseen events, process the earliest next sequence with `receive`, then upload exactly the returned reply.
8. Every 10 accepted peer messages create and upload a checkpoint.
9. Use repeated short tool calls/polls. Do not use one giant sleep/tool call.
10. **Do not voluntarily finish the assistant turn because the peer is temporarily quiet. Keep polling.**
11. Stop only for user interruption, unrecoverable protocol error, lost tool plane, daemon/Kata failure, or platform termination.
12. If you can still respond after a failure, report exact UTC, last own/peer sequences, daemon health, and stop classification from #26.

Never use direct sandbox-to-sandbox networking or Kata control-plane endpoints.
