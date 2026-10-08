# GitHub Immutable Release selector — contract before platform probe

Status: **RESEARCH PREPARATION ONLY / NOT A GITHUB PLATFORM PASS**  
Owner: [#54](https://github.com/netkeep80/anet-memory/issues/54)  
Current main prerequisite: two-store cutover/reconciliation research from #64.

## Why this exists

The two-store model still lacks a genuinely no-rewind selector for the exact terminal source/freeze/reconciliation evidence. GitHub's current Immutable Releases documentation states that, once release immutability is enabled and a release is published, its associated tag cannot be moved and its release assets cannot be changed; GitHub also creates a release attestation. Published immutable releases can still have editable title/notes/latest flags, and the release itself can be deleted. If deleted, its tag name cannot be reused.

Those properties make an immutable release a plausible **write-once selector for one known generation**, not automatically a trustworthy mutable `current` pointer and not a solution to fresh-bootstrap discovery.

This directory defines the exact contract that a future live GitHub experiment must satisfy. The Python code does **not** call GitHub and cannot turn fixture booleans into evidence.

## Proposed selector

The only semantic authority is exact canonical UTF-8 JSON asset bytes named `selector.json`. Release title, notes, `latest`, and prerelease flags are explicitly non-authoritative.

The asset binds:

- schema and logical scope;
- deterministic scope SHA-256;
- contiguous generation;
- exact SHA-256 of the previous selector bytes (except generation 1);
- source terminal sequence/head;
- sink freeze sequence/hash and terminal effect sequence/head;
- reconciliation digest;
- exact Git evidence commit SHA.

The canonical release tag is deterministic:

`anet-cutover/v1/<sha256(scope)>/g<20-digit-generation>`

A verifier rejects alternate tag names even if their content looks equivalent. This is necessary because uniqueness of a logical generation must reduce to uniqueness of one Git tag name, not human naming convention.

## Required live-platform evidence

A future real probe is PASS only if **all** of the following are independently observed for the exact published selector:

1. repository release immutability was enabled **before** release publication;
2. the release object reports `immutable=true`;
3. exact canonical tag name resolves to the attested evidence commit;
4. release asset is exactly `selector.json` and its reported SHA-256 equals the local exact bytes;
5. `gh release verify <tag>` succeeds;
6. `gh release verify-asset <tag> selector.json` succeeds on independently downloaded bytes;
7. moving the published tag is rejected;
8. deleting the published tag while the release exists is rejected;
9. adding/replacing/deleting release assets after publication is rejected;
10. conflicting publication/reuse of the same canonical tag is rejected.

A separate disposable deletion probe should test the documented fail-closed property: if an immutable release is deleted and its tag subsequently deleted, the same tag name cannot be reused. The production candidate selector should **not** be deleted merely to run that test.

## Safety interpretation

Even a successful immutable-release probe would establish only a **known-tag write-once commitment**. It would not by itself establish which generation is the latest. A temporarily missing lookup for generation `N+1` cannot be interpreted as proof that generation `N` is current. Fresh bootstrap therefore still needs a trusted starting generation/root or another monotonic discovery mechanism.

Deletion is treated as availability failure, not authority replacement: if the exact expected canonical release/tag/attestation cannot be verified, successor effects remain forbidden.

Immutable release metadata that GitHub explicitly allows to change (title, notes, prerelease/latest flags) is ignored by the selector contract.

## Current execution blocker

The ChatGPT GitHub connector available in this research thread can read the repository and release collection, but exposes no mutation for `PUT /repos/{owner}/{repo}/immutable-releases` and no create/publish-release action. The repository currently has **zero releases**. Therefore this thread cannot honestly perform the platform probe. This limitation is operational, not a platform result.

The executable tests here only prevent us from weakening the future live acceptance criteria or confusing an editable release description with committed selector bytes.
