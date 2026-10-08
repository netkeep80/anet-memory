# Live GitHub + ChatGPT Library generation run

Status: **RESEARCH EVIDENCE / SAME CHAT / NO EXTERNAL EFFECTS**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
Run: `github-library-generation-live-20261009-01`

## Goal

Execute the minimal protocol from the merged `github-library-generation` research against real ChatGPT Library objects and a real disposable GitHub authority ref.

This run intentionally used no daemon, SQLite or third-party database.

## Library objects

Three exact JSON roots were created locally, uploaded to ChatGPT Library, independently materialized back, and byte-compared before any GitHub authority commit was accepted.

| object | file_id | size | SHA-256 |
| --- | --- | ---: | --- |
| g1 | `file_00000000c30c81f4a49fb4c86375c44e` | 218 | `e8819403c850bc42a3e1e59b679467b4ce2192d9e064f1135fb1eefd633284fe` |
| g2-A | `file_00000000d08882468c54a78dc4046a92` | 209 | `da259f4a317dd52e651fb75b0aa5afa25548c3c88c66259eea651c6ddcade0cd` |
| g2-B | `file_00000000f31081f4b24047f4a06a9a80` | 209 | `d8d0b09839239027822cbe858b2fd1bb28acc04fa144fe62cff10590ef5148d0` |

All original-vs-Library readbacks passed exact `cmp` and SHA-256 equality.

## Generation 1

Authority branch:

`research/github-library-live-authority-20261009-01`

Authority base:

`3c0bf5d9698d60eb91afcf9c48f231d05ea962c9`

Generation-1 candidate commit:

`d51982ca84c7be2263fa5a4a21caa7ce509c39f5`

The ref advanced from the base to generation 1 using `expected_sha=base, force=false`: success.

## Real generation-2 race

Two candidate commits were built from the same generation-1 parent:

- A: `a41f5bcf91a3f84a3ec832ca39b4e09214b35bf2`
- B: `2a547acad8d2335842c47eb3c041b42671b69303`

Both requested:

`update_ref(expected_sha=d51982ca..., force=false)`

Observed:

- A -> `success:true`;
- B -> rejected with the connector's generic GraphQL `UNKNOWN` stale-head outcome.

Independent authority reread returned A as the exact current head.

## Consumer path

The consumer did not use the remembered race winner.

It independently:

1. reread the GitHub authority ref;
2. fetched `generation.json` from the authoritative head;
3. obtained A's exact Library `file_id/path/size/SHA-256` from that GitHub record;
4. materialized that `file_id` into a new consumer-readback directory;
5. verified 209 bytes and SHA-256 `da259f4...`.

The exact selected bytes contained candidate `A`.

## Visible loser falsifier

A Library folder listing after the race showed **both** `g2-a.json` and `g2-b.json` present and visible, plus `g1.json`.

Therefore Library visibility did not choose the winner. Candidate B remained a real durable object but was **not authoritative** because GitHub did not select its commit.

This directly demonstrates the intended separation:

```text
Library visibility/existence != COMMITTED
GitHub-selected exact bytes  = selected committed generation
```

## Classification

- `PASS_SAME_CHAT_LIVE_GITHUB_LIBRARY_GENERATION`
- exact Library byte roundtrip: PASS
- GitHub CAS single winner: PASS
- visible orphan not authoritative: PASS
- fresh-chat / different-sandbox replay: **PENDING**
- server-side GitHub no-rewind: **NOT PROVEN**
- external effects: **FORBIDDEN**

The remaining hard authority issue is still #68's result: the current credential can force-rewind an unprotected Git ref. This live run proves the data/control-plane composition, not server-side non-rewind governance.
