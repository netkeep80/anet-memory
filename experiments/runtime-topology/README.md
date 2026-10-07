# ChatGPT runtime topology research — final observed model

Status: **experimental evidence summary**  
Research issue: #43  
Date: 2026-10-08  
Scope: Scheduled Tasks, interactive chats, ChatGPT Library, per-chat/per-run sandboxes, local daemons, and cross-sandbox transport.

This report records only properties observed by isolated experiments. It deliberately distinguishes **observed behavior** from a platform guarantee.

## Executive result

The experimentally supported ANet runtime topology is:

```text
same sandbox
============

interactive/scheduled model worker
          |
          | direct localhost HTTP
          v
      local daemon
          ^
          |
          +---------------------+
                                |
                 opportunistic fast path


different sandboxes
===================

daemon A
   ^
   | localhost
   v
model/harness worker A
   |
   | persistent Library objects
   v
ChatGPT Library
   ^
   | persistent Library objects
   |
model/harness worker B
   ^
   | localhost
   v
daemon B
```

The direct peer path:

```text
daemon A ---- raw sandbox IPv4 ----> daemon B
```

was tested between two different sandboxes and failed closed with `No route to host`.

Therefore:

1. **ChatGPT Library is the first proven durable cross-chat/cross-sandbox bus.**
2. **localhost is a proven bidirectional intra-sandbox fast path.**
3. **sandbox/process affinity exists in some runs but is not durable and must never be a correctness requirement.**
4. **Scheduled Tasks can act as periodic reasoning/gateway workers, but not as durable state.**
5. **Model/harness capabilities such as Library/GitHub connectors must not be assumed to exist inside daemon processes.**
6. **Direct sandbox-to-sandbox container networking is not a supported ANet transport based on current evidence.**

## Final capability matrix

| Edge / property | Result | Evidence |
|---|---|---|
| scheduled run sees originating-chat context beyond saved task prompt | **OBSERVED** | control marker recovered by scheduled probe |
| scheduled run receives an execution sandbox | **OBSERVED** | hostname/pwd/kernel/`/mnt/data` probe |
| scheduled worker can read ChatGPT Library | **PASS** | read-only probe |
| scheduled worker can write + re-read Library | **PASS** | X3A |
| scheduler A -> Library -> scheduler B with hidden nonce | **PASS** | X3A/X4A |
| same scheduled task keeps the same local filesystem between runs | **NO / NOT_PERSISTENT** | X1/X2 |
| scheduled worker can directly reach a daemon in the same live sandbox | **PASS** | X5D |
| later scheduled invocation can retain affinity to the same live daemon | **OBSERVED, NOT GUARANTEED** | X5E |
| daemon can emit before scheduler wake-up and receive later ACK over localhost | **PASS** | X5F |
| fresh chat B can consume Library data in a different sandbox | **PASS** | cross-chat bridge |
| daemon A -> Library -> fresh chat B -> daemon B -> Library -> daemon A | **PASS** | full cross-chat/cross-sandbox round trip |
| direct daemon A -> daemon B using sandbox IPv4 | **FAIL_CLOSED** | direct cross-sandbox probe |
| local daemon inherits GPT connector access | **NOT PROVEN; MUST NOT BE ASSUMED** | connector/raw-network separation |
| arbitrary chat enumeration/addressing by chat identity | **NOT DISCOVERED** | capability probe |
| five staggered schedulers as a production supervisor | **NOT YET ACCEPTED** | implementation/reliability work remains |

## Experiment results

### E1 — Scheduled invocation can inherit originating-chat context

A read-only Scheduled Task was created without embedding a control-marker value in the task prompt.

The scheduled run recovered the marker from the originating conversation.

Observed consequence:

- a Scheduled Task invocation may receive more originating-chat context than its persisted task prompt;
- this is useful for continuity;
- it is also a contamination risk for isolation experiments.

It does **not** imply access to arbitrary unrelated chats.

### E2 — Scheduled invocation has a sandbox

Initial scheduler probe observation included:

```text
hostname = 247a0f223710
pwd      = /
kernel   = Linux 6.18.44 x86_64
/mnt/data = empty at probe time
```

This establishes a VM/container-like execution plane for scheduled reasoning work.

### X1/X2 — scheduled sandbox persistence

RUN_ID:

```text
scheduler-vm-persistence-20261008-01
```

Phase 1:

```text
hostname = 3c812396c1a8
local probe = /mnt/data/scheduler-vm-persistence-20261008-01-local.json
```

Phase 2:

```text
hostname = bd783e458bcb
phase-1 local probe = absent
classification = NOT_PERSISTENT
```

The later run still had previous scheduled/originating context visible to the model independently of Library.

Conclusion:

> Model-visible task/chat continuity and sandbox/filesystem continuity are different mechanisms.

No protocol may use `/mnt/data`, hostname, or a daemon PID as durable state.

### X3A/X4A — scheduled worker -> Library -> scheduled worker

RUN_ID:

```text
scheduler-library-bridge-20261008-01
```

Producer:

```text
Library object = scheduler-library-bridge-20261008-01-msg.json
SHA-256        = 10924b5a88fb2fd971e55ade9967740f45e9894d08eaf5fa71b0eb1780232382
```

Consumer independently learned the nonce only from the Library object and produced:

```text
ACK object = scheduler-library-bridge-20261008-01-ack.json
ACK SHA-256 = e2cc9b7bff9703ef92cb2e4ccc8e010ae44611eb01e6ac162c0b0a664882f980
```

Both exact Library objects were independently rediscovered and verified.

Result:

```text
scheduled worker A
        |
        v
     Library
        |
        v
scheduled worker B
        |
        v
     Library ACK

PASS
```

Relevant #43 evidence comment: `6048178906`.

A scheduled-run attempt to write GitHub evidence was blocked by connector safety checks. The Library transport itself was unaffected. This is one reason GitHub mutation is not the primary runtime bus.

### Shared-sandbox observation

The X3A producer, X4A consumer, and later originating interactive turn all observed:

```text
hostname = bd783e458bcb
```

The interactive turn could also see local files created by those scheduled runs.

At the same time the independent VM persistence probe had previously used:

```text
hostname = 3c812396c1a8
```

Therefore shared sandbox assignment is real, but not universal.

Relevant #43 evidence comment: `6048199058`.

### X5D — scheduled worker -> live interactive daemon over localhost

RUN_ID:

```text
scheduler-local-daemon-20261008-01
```

Daemon identity:

```text
hostname   = bd783e458bcb
pid        = 510
started_at = 2026-10-07T22:31:21.278296Z
endpoint   = 127.0.0.1:19171
```

A scheduled invocation directly POSTed an application message to the daemon without using Library/GitHub as the application transport.

Message SHA-256:

```text
512827bdf9d4692f375b3a7fa6667b4e4ee4bf5ff9a70b8eb3ca61b1154d06e0
```

The originating interactive turn later independently verified daemon state/log and the same canonical hash.

Classification:

```text
PASS_DIRECT_LOCALHOST
```

Relevant #43 evidence comment: `6048354049`.

### X5E — later scheduled invocation retained affinity

RUN_ID:

```text
scheduler-local-daemon-affinity-20261008-01
```

A later independent Scheduled Task observed the same:

```text
hostname   = bd783e458bcb
pid        = 510
started_at = 2026-10-07T22:31:21.278296Z
```

Classification:

```text
SAME_LIVE_SANDBOX
```

This proves that live process affinity can survive multiple scheduled invocations.

It does **not** create a durability guarantee, because X1/X2 separately observed sandbox reassignment and loss of local files.

Relevant #43 evidence comment: `6048596351`.

### X5F — daemon -> scheduler -> daemon, direct localhost

RUN_ID:

```text
scheduler-daemon-bidir-20261008-01
```

Daemon:

```text
hostname   = bd783e458bcb
pid        = 775
started_at = 2026-10-07T23:02:20.803079Z
endpoint   = 127.0.0.1:19172
```

The daemon autonomously emitted an application message before the scheduled invocation observed it.

Event chronology:

```text
daemon EMIT = 2026-10-07T23:03:05.807804Z
scheduler ACK persisted = 2026-10-07T23:07:41.916324Z
```

Hashes:

```text
outbound = 26d43868c640ae99d9a9cf6964e7f428f5ea4595187a496a2fd51e358ab97c3b
ACK      = 570db81363cc9f00b1b1992d6b0cd3901cbea17c3057935c7b7b92ed99aed496
```

Classification:

```text
PASS_BIDIRECTIONAL_DIRECT_LOCALHOST
```

This proves a useful event model:

```text
daemon prepares local event
        |
        v
scheduler tick wakes model worker
        |
        v
worker reads/acts/replies through localhost
        |
        v
daemon persists reply
```

A daemon does not need to wake the model directly for a scheduler-driven supervisor design.

Relevant #43 evidence comment: `6048718368`.

## Full cross-chat/cross-sandbox bridge

RUN_ID:

```text
cross-chat-daemon-bridge-20261008-01
```

Producer A:

```text
hostname   = bd783e458bcb
daemon pid = 968
started_at = 2026-10-07T23:17:14.064736Z
```

Source Library object:

```text
/anet-memory/v1/experiments/cross-chat-daemon-bridge-20261008-01/msg.json
```

Integrity:

```text
wrapper SHA-256 = d47b5159e8a3d7db67bf4ed6663b02629f5338aeb7c55678afb5586a5041bed3
message SHA-256 = 2e5086117f2a8f45be959325688821ca901861c72a37fbdaa814747afd44355a
```

Producer staging evidence: #43 comment `6048813520`.

Fresh consumer B:

```text
hostname   = 4be3b3cc32a5
daemon pid = 438
started_at = 2026-10-07T23:25:15.844861Z
```

The consumer hostname was different from producer A, so this was a genuine different-sandbox observation.

Consumer B:

1. independently found the exact Library source;
2. materialized and verified the expected wrapper SHA-256;
3. learned the nonce only from the Library source;
4. started daemon B locally;
5. delivered the source message once to daemon B over localhost;
6. had daemon B generate an ACK;
7. uploaded the exact ACK to:

```text
/anet-memory/v1/experiments/cross-chat-daemon-bridge-20261008-01/ack.json
```

ACK SHA-256:

```text
f8bbcdd6a42b22f4069a7591b5c144c9ec90d5dfe0b90aace86d60bc39763fc6
```

The producer-side worker then independently rediscovered/materialized the ACK, verified nonce continuity and hashes, and delivered the ACK once to still-live daemon A over localhost. Daemon A persisted the same ACK hash.

Final classification:

```text
PASS_CROSS_CHAT_CROSS_SANDBOX
```

Observed complete path:

```text
daemon A
   |
   | localhost
   v
worker/chat A
   |
   | Library
   v
fresh chat B in different sandbox
   |
   | localhost
   v
daemon B
   |
   | Library ACK via worker B
   v
worker/chat A
   |
   | localhost
   v
daemon A
```

Properties proven by this run:

- cross-chat transport: **YES**
- cross-sandbox transport: **YES**
- local daemon B delivery: **YES**
- ACK returned to daemon A: **YES**
- manual nonce handoff: **NO**
- source and ACK byte/hash verification: **PASS**

The final large GitHub evidence comment for this run was blocked by connector safety filtering; this repository report preserves the consolidated result.

## Direct daemon-to-daemon cross-sandbox network probe

RUN_ID:

```text
direct-daemon-cross-sandbox-20261008-01
```

This experiment deliberately removed Library/model mediation from the application data plane. Library was used only as a rendezvous/control plane to publish daemon B coordinates.

Producer A:

```text
hostname   = bd783e458bcb
IPv4       = 172.26.39.199
daemon pid = 1185
started_at = 2026-10-07T23:35:11.166736Z
```

Source application message SHA-256:

```text
78e4dd016f3138e154a3ad977a688f13d6e08134b4b15c98b4a942730e7e3f6e
```

Consumer B:

```text
hostname   = 07823f4f5c71
IPv4       = 172.26.39.190
daemon pid = 403
started_at = 2026-10-07T23:37:27.554594Z
listener   = 0.0.0.0:19175
```

Rendezvous contact card:

```text
/anet-memory/v1/experiments/direct-daemon-cross-sandbox-20261008-01/contact-b.json
SHA-256 = 30c4e2e710d4b0a73ae90c8799fec3818c550044676db9bd01945aec25bfcfc0
```

The producer independently materialized and verified the contact card.

Exactly one direct network send attempt was made by daemon A.

Result:

```text
URLError: [Errno 113] No route to host
```

Additional producer-side network evidence:

- route lookup selected `eth0` with source `172.26.39.199`;
- neighbor discovery for `172.26.39.190` ended in `FAILED`;
- daemon A logged `DIRECT_FAIL`;
- no application ACK was produced;
- no Library/model fallback was used;
- no retry was performed.

Classification:

```text
FAIL_CLOSED_DIRECT_CROSS_SANDBOX_NETWORK
```

Important conclusion:

> Similar/on-link-looking container IPv4 addresses do not imply sandbox peer reachability.

Relevant #43 evidence comment: `6049069644`.

## Connector/network boundary

The experiments require a strict distinction between model/harness capabilities and daemon/container capabilities.

Observed model/harness capabilities included:

- ChatGPT Library;
- GitHub connector;
- web access;
- scheduled task state.

These are **not automatically daemon APIs**.

A separate interactive-sandbox probe also observed raw DNS/HTTPS failure for `curl https://api.github.com/`. That observation is supporting evidence only; the architectural rule is stronger and simpler:

> A connector available to a model invocation must never be treated as a network capability inherited by a local daemon unless independently demonstrated.

## Resulting ANet architecture

### Durable cross-sandbox path

Use the persistent bus as the source of truth:

```text
daemon
  |
  | localhost adapter
  v
reasoning/gateway worker
  |
  | immutable Library message/ACK
  v
ChatGPT Library
  |
  v
reasoning/gateway worker
  |
  | localhost adapter
  v
daemon
```

### Opportunistic intra-sandbox fast path

When a scheduled invocation is placed into the sandbox containing a live daemon, direct localhost delivery is valid after identity verification.

Recommended daemon identity tuple:

```text
(run_id, hostname, pid, started_at, token/fingerprint)
```

Never accept PID alone.

If identity/localhost fails, fall back to durable recovery semantics. Do not recreate a daemon and silently classify that as successful direct delivery.

### Correctness rule

**No correctness invariant may depend on:**

- a stable hostname;
- a stable PID;
- a stable `/mnt/data`;
- repeated scheduler assignment to one sandbox;
- direct container peer routing;
- model-visible previous-run context.

Durable correctness must be reconstructible from persistent ANet/transport state.

## Scheduler supervisor design implications

The runtime topology supports a scheduler-driven supervisor, but the supervisor itself still needs a separate acceptance test.

A five-task phase-shifted clock can approximate one tick every 12 minutes:

```text
:00  supervisor/0
:12  supervisor/1
:24  supervisor/2
:36  supervisor/3
:48  supervisor/4
```

Because any tick may execute in any sandbox, every tick must:

1. read authoritative durable supervisor state;
2. acquire a lease/fencing token before mutating shared work;
3. tolerate duplicate execution;
4. tolerate an old worker completing late;
5. use per-message/channel idempotency;
6. fail closed on forks/gaps;
7. verify local daemon identity before localhost fast-path delivery;
8. publish durable progress before relying on a future tick;
9. never require one worker's local filesystem to survive;
10. allow recovery by another scheduler/chat.

This is the correct continuation of #43, not further topology probing.

## Relationship to sandbox-bus/1

This research reinforces the existing transport direction in #2:

- Library is a persistent object transport, not a shared filesystem;
- local sandbox state is cache/scratch;
- delivery should remain at-least-once/idempotent;
- ordered channels still require sequence + previous-message continuity;
- ACK remains a protocol event;
- exact payload bytes/hashes remain the transport integrity authority.

The new result adds one important optimization boundary:

> local daemon IPC/HTTP may bypass Library **only inside a verified shared live sandbox**. It must not create a second semantic protocol or a second source of truth.

## Open questions intentionally left outside this topology report

The following are separate research/implementation questions:

- Library read-after-write/listing latency distributions (#7);
- retention guarantees (#7);
- concurrent create/update behavior (#7);
- production supervisor leases/fencing and duplicate-run handling;
- daemon lifecycle management and recovery policy;
- whether any future platform-provided external networking channel can safely expose daemon endpoints.

They do not invalidate the topology conclusions above.

## Final status

Runtime topology research is complete enough to stop probing basic edges and start implementing the supervisor/gateway design.

Canonical decision:

```text
cross-sandbox authority/transport = durable Library-backed bus
same-sandbox optimization         = verified localhost fast path
scheduler                         = periodic reasoning/gateway worker
daemon                            = ephemeral local executor
direct sandbox peer networking    = unsupported by observed evidence
```

Do not weaken these boundaries without a new isolated falsification experiment.
