# GitHub authority ref ruleset contract

Status: **RESEARCH CONTRACT / PLATFORM NOT YET PROVEN**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)

## Purpose

The minimal ANet Memory architecture already has:

- ChatGPT Library JSON/files as the durable data plane;
- GitHub generation commits/ref as the control-plane selector;
- expected-head CAS as the competing-writer serialization mechanism.

Live #68 proved the remaining defect: the currently unprotected ref can be rewound by the same writer with `force=true`.

This contract defines the minimum GitHub server-side rules required to remove that defect **without adding any database or daemon**.

## Authority namespace

Target only:

```text
refs/heads/anet-authority/**
```

Do not apply this research contract to `main`, ordinary development branches, #26, #52 or accepted `sandbox-bus/1`.

## Required ruleset

Canonical desired state:

```json
{
  "name": "anet-memory-authority-non-rewind-v1",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/anet-authority/**"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"}
  ]
}
```

Meaning:

- `non_fast_forward`: matching authority refs cannot be force-pushed/repointed backward or to a non-fast-forward history by ordinary writers;
- `deletion`: matching authority refs cannot be deleted by ordinary writers;
- empty `bypass_actors`: no execution principal is allowed to bypass those protections;
- ordinary fast-forward updates remain allowed and are still guarded by ANet's `expected_sha=current_head` CAS lease.

No `update` restriction is required: the whole point is to allow the current generation to advance to its exact child while preventing history rewrite.

No `creation` restriction is required by this contract. Creation policy can be tightened later, but it is not necessary to prove non-rewind once an authority ref exists.

## Why the bypass list matters

A ruleset that blocks force pushes but grants the ChatGPT/GitHub execution identity an `always` bypass does **not** solve #68.

Acceptance requires the exact fetched full ruleset to expose an empty bypass list. If the connector/account cannot read `bypass_actors`, classification is **BYPASS_VISIBILITY_UNKNOWN** and the ruleset must not be accepted as authority.

## Live probe

The live probe must use a fresh disposable matching ref such as:

`anet-authority/probe-<unique-attempt-id>`

Procedure after the ruleset is ACTIVE:

1. independently fetch the full ruleset and validate this contract;
2. create the probe branch at an existing commit;
3. create a direct child commit;
4. advance `base -> child` with `expected_sha=base, force=false`;
   this MUST succeed;
5. attempt `child -> base` with `expected_sha=child, force=true`;
   this MUST be rejected by GitHub;
6. independently reread the ref; it MUST remain at `child`;
7. create another direct child and perform an ordinary `expected_sha=child, force=false` update;
   this MUST succeed, proving the ruleset permits monotonic authority advancement.

Required classification if steps 1-7 pass:

`PASS_GITHUB_SERVER_SIDE_NON_REWIND_FORCE_PROBE`

## Delete probe

The current ChatGPT GitHub connector has no delete-ref mutation.

Therefore deletion acceptance has two separate levels:

- exact active ruleset contains `{"type":"deletion"}` and has no bypass -> **DELETION_POLICY_PRESENT**;
- an actual attempted delete through an authorized GitHub mutation surface is rejected -> **PASS_GITHUB_SERVER_SIDE_DELETE_PROBE**.

Until the second observation exists, deletion is **POLICY_VERIFIED / MUTATION_PROBE_PENDING**, not fully live-proven.

## Fail-closed rules

Do not accept the ruleset when any of these are true:

- ruleset enforcement is not `active`;
- target is not `branch`;
- exact authority pattern is missing;
- an exclusion can remove the authority namespace from coverage;
- `non_fast_forward` is missing;
- `deletion` is missing;
- bypass list is non-empty;
- bypass list is unavailable/hidden;
- live force-rewind unexpectedly succeeds;
- force attempt errors but independent reread shows the ref actually moved;
- ordinary fast-forward cannot proceed after protection.

## Operational setup

The current ChatGPT GitHub connection can read repository rulesets but does not expose the Administration-write mutation required to create one.

The ruleset therefore must be enabled once through an admin-capable GitHub surface. After that, this repository's verifier and the existing `update_ref` tool are sufficient to run the force-rewind live probe.

This is a GitHub configuration dependency, not a new ANet runtime component.

## Non-claims

This contract does not by itself prove:

- fresh-chat Library replay (separate #76 gate);
- deletion mutation rejection until a delete-ref surface is available;
- security if an attacker obtains a distinct GitHub administrative credential that can edit/disable the ruleset;
- irreversible external effects.

`external_effects_allowed=false`.
