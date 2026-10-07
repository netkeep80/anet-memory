# Dual-thread endurance experiment

Owner: #26  
Lifecycle evidence: #25

## Purpose

Measure how long two independent ChatGPT threads can remain in active thinking turns while each runs its own `anet-memoryd` and the two nodes continuously exchange ordered `sandbox-bus/1` events through ChatGPT Library.

This is an endurance measurement, not an availability/SLA claim.

## Topology

```text
Thread A / Kata A                    Thread B / Kata B
    |                                    |
anet-memoryd A                       anet-memoryd B
    |                                    |
    +---------- ChatGPT Library ---------+
```

No direct VM-to-VM networking is used.

## Run identity

Choose one shared path-safe `RUN_ID`, for example:

```text
endurance-20261007-01
```

Use exactly the same run ID in both chats.

## Bootstrap

Each node must use the same pinned repository commit. Before a real run, record the exact commit SHA in #26.

Required local files:

```text
src/sandbox-bus.mjs
src/anet-memoryd.mjs
src/memory-events.mjs
src/memory-views.mjs
experiments/dual-thread-endurance/node.mjs
```

Each chat should retrieve these from the pinned GitHub commit and place them under one local repo root.

Then:

Thread A:

```bash
node experiments/dual-thread-endurance/node.mjs prepare \
  --run "$RUN_ID" --node thread-a --peer thread-b
```

Thread B:

```bash
node experiments/dual-thread-endurance/node.mjs prepare \
  --run "$RUN_ID" --node thread-b --peer thread-a
```

`prepare` starts a loopback-only daemon if needed, starts a 5-second background watcher, creates local experiment state, and emits the first HELLO envelope plus the exact Library destination.

The ChatGPT thread uploads that file append-only using the Library tool.

## Active loop

After both HELLO objects are published, each chat stays in one active assistant turn and repeatedly:

1. poll local `/health`;
2. inspect Library peer channel;
3. materialize the earliest unseen peer envelope;
4. run `node.mjs receive --file <local-path> ...`;
5. upload the returned outgoing envelope to its exact Library destination;
6. rediscover/verify the uploaded object;
7. every 10 accepted peer messages run `checkpoint` and upload it;
8. pause roughly 5–15 seconds using a short operation;
9. repeat.

Never use one giant sleeping shell/tool call. The experiment is specifically testing whether repeated short tool interactions can keep one thinking turn alive.

Temporary absence of a Library object is not a failure; keep polling.

## Lock-step invariant

Both nodes publish sequence 1 independently.

After that, an unseen accepted peer event authorizes exactly one new local event.

Therefore a channel cannot advance merely because one node is alive and blindly publishing.

## Commands

```bash
# Prepare/start daemon + watcher + HELLO
node experiments/dual-thread-endurance/node.mjs prepare --run RUN --node NODE --peer PEER

# Accept exactly one materialized peer envelope and produce the next reply
node experiments/dual-thread-endurance/node.mjs receive --run RUN --node NODE --peer PEER --file /path/to/message.json

# Snapshot local state + daemon
node experiments/dual-thread-endurance/node.mjs status --run RUN --node NODE --peer PEER

# Durable checkpoint candidate
node experiments/dual-thread-endurance/node.mjs checkpoint --run RUN --node NODE --peer PEER
```

## Library layout

```text
/sandbox-bus/v1/experiments/dual-thread-endurance/<run-id>/
  messages/
    thread-a/thread-b/
    thread-b/thread-a/
  checkpoints/
    thread-a/
    thread-b/
```

Every object is immutable.

## Local evidence

```text
/mnt/data/anet-memory-endurance/<run-id>/<node>/
  experiment-state.json
  orchestrator.jsonl
  daemon-watch.jsonl
  daemon.pid
  watcher.pid
  daemon.stdout.log
  daemon.stderr.log
  outbox/
  incoming/
  checkpoints/
  memoryd/
```

## End of run

Do not interpret an individual tool timeout as sandbox death.

After either active turn ends, a later inspection should compare:

- final Library sequences in both directions;
- last durable checkpoints;
- both local watcher logs if their Kata VMs still exist;
- daemon PID/start time if still alive.

Classify the first observable stop reason using #26.

## Important

The experiment intentionally does not attempt to bypass ChatGPT/Kata isolation or access internal control-plane endpoints.
