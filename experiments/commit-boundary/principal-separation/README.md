# Principal separation — execution writer vs control/admin capability

Status: **RESEARCH ONLY / SYNTHETIC EFFECTS ONLY**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)

## Why this exists

After #67, an authentic-but-stale selector can be contained **if every irreversible effect reaches one authoritative fencing sink**. After #68, a shared GitHub write credential was shown to provide useful expected-head fencing but not non-rewind authority.

The remaining question is not only *where* the authority state lives. It is also **which principal may mutate it**.

A remote transactional database solves cross-sandbox serialization only if execution agents do **not** share the same administrative/control capability that can read successor credentials, rewrite authority rows, or bypass the effect RPC.

This experiment makes that trust boundary executable using the already-merged #63 fenced sink.

## Composed dependency

The model imports:

`../fenced-effect-sink/fenced_effect_sink.py`

No replacement sink semantics are introduced.

The accepted API already separates:

- generation-scoped writer credentials;
- a distinct control credential for authority rotation;
- direct underlying SQLite tables.

This experiment deliberately exposes negative raw-admin helpers to model what happens when an execution chat is given privileges equivalent to unrestricted SQL access.

## Positive case

An old execution principal knows only its generation-1 writer credential.

After legitimate rotation to generation 2:

- old writer request is rejected `STALE_AUTHORITY`;
- the old principal cannot call the control operation;
- it cannot read the successor credential;
- it cannot rewrite the authority row;
- it cannot insert effect state directly.

Classification:

`GENERATION_SCOPED_WRITER_ONLY`

This is the minimum capability shape that can support the stale-selector containment result.

## Negative controls

### Shared successor credential

If the old execution principal can see the generation-2 writer secret, it can impersonate the successor. Therefore successor capability material must not be stored in GitHub, ChatGPT Library, shared memory, logs, or any other source readable by the stale executor.

### Raw database read/admin capability

The experiment directly reads the private `writer_keys` table after rotation, recovers the new writer secret, signs a generation-2 request, and the sink accepts it.

Therefore a connection that can arbitrarily query the authority database is inside the trusted computing base. It is **not** a safe credential to expose to autonomous execution chats.

### Raw database write/admin capability

The experiment performs direct SQL DML after a legitimate generation-2 rotation:

1. rewrites authority back to generation 1 / old writer;
2. old writer then successfully appends `EFFECT_APPLIED(generation=1)` **after** an `AUTHORITY_ROTATED(generation=2)` ledger entry.

This explicitly bypasses the fence.

A second direct-DML negative test inserts an effect-index row without a corresponding ledger receipt, proving that unrestricted table write privilege can bypass both idempotency protocol interpretation and receipt ordering.

### Shared control capability

A principal that holds the control credential can choose the next preprovisioned writer. If the same stale execution principal also holds that future writer capability, it can rotate authority to itself and apply.

Therefore **control-plane authority must not be colocated with execution-writer capability**.

## Architectural rule

The relevant security boundary is:

```
execution principal
  MAY: call apply_effect using only its current generation-scoped capability
  MUST NOT: rotate authority
  MUST NOT: read successor capabilities
  MUST NOT: issue arbitrary SQL
  MUST NOT: mutate authority/effect tables directly

control principal
  MAY: perform narrowly scoped monotonic rotation
  MUST NOT: execute ordinary application effects

database owner/admin
  MAY: administer schema
  MUST NOT: be the routine credential available to disposable execution chats
```

A database is not “non-clonable authority” merely because it is remote. The service endpoint and credentials must enforce this capability split.

## Implication for PostgreSQL / Supabase

A future live remote-store experiment should **not** give execution chats a project-admin SQL connector and then claim writer isolation.

Instead the target architecture needs a narrow server-side RPC/function surface:

- private authority and effect tables;
- direct table privileges revoked from execution roles;
- `apply_effect` callable by a generation-scoped writer principal/token;
- `rotate_authority` callable only by a distinct control principal;
- both operations serialize on the same authoritative scope row;
- global `UNIQUE(scope,effect_key)` idempotency;
- no API that returns future writer credentials to old execution principals.

Supabase documents that database functions live inside Postgres and can be invoked remotely through RPC; PostgreSQL provides row locking and atomic conflict handling. Those are promising mechanics, but **the live cross-sandbox authority claim remains pending until role/capability isolation is actually tested on a connected remote store**.

## Result classification

The expected classification is:

`PASS_PRINCIPAL_SEPARATION_NECESSITY_MODEL`

with explicit limits:

- local SQLite remains only the test host;
- HMAC/test secrets are fixture credentials, not production ChatGPT identities;
- this does not prove Supabase/PostgreSQL deployment or ACLs;
- this does not prove cross-sandbox token delivery/revocation;
- this does not enable external effects.

`external_effects_allowed=false` throughout. #54 stays OPEN; #52 stays effect-disabled.
