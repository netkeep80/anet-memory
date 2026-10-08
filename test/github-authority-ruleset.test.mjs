import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  inspectAuthorityRuleset,
  classifyForceProbe,
} from '../experiments/commit-boundary/github-authority-ruleset/ruleset-verifier.mjs';

const desired = JSON.parse(readFileSync(
  'experiments/commit-boundary/github-authority-ruleset/desired-ruleset.json',
  'utf8',
));

test('canonical desired ruleset is accepted', () => {
  assert.deepEqual(inspectAuthorityRuleset(desired), {
    accepted: true,
    classification: 'RULESET_CONTRACT_VERIFIED',
    authority_pattern: 'refs/heads/anet-authority/**',
    force_rewind_policy: 'BLOCKED',
    deletion_policy: 'BLOCKED',
    bypass_count: 0,
  });
});

test('inactive ruleset is rejected', () => {
  const r = structuredClone(desired);
  r.enforcement = 'disabled';
  assert.equal(inspectAuthorityRuleset(r).classification, 'RULESET_NOT_ACTIVE');
});

test('wrong target is rejected', () => {
  const r = structuredClone(desired);
  r.target = 'tag';
  assert.equal(inspectAuthorityRuleset(r).classification, 'WRONG_RULESET_TARGET');
});

test('missing authority pattern is rejected', () => {
  const r = structuredClone(desired);
  r.conditions.ref_name.include = ['refs/heads/main'];
  assert.equal(inspectAuthorityRuleset(r).classification, 'AUTHORITY_PATTERN_NOT_INCLUDED');
});

test('any authority exclusion fails closed', () => {
  const r = structuredClone(desired);
  r.conditions.ref_name.exclude = ['refs/heads/anet-authority/unsafe'];
  assert.equal(inspectAuthorityRuleset(r).classification, 'AUTHORITY_EXCLUSIONS_NOT_ALLOWED');
});

test('hidden bypass list fails closed', () => {
  const r = structuredClone(desired);
  delete r.bypass_actors;
  assert.equal(inspectAuthorityRuleset(r).classification, 'BYPASS_VISIBILITY_UNKNOWN');
});

test('non-empty bypass list is rejected', () => {
  const r = structuredClone(desired);
  r.bypass_actors = [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
  assert.equal(inspectAuthorityRuleset(r).classification, 'BYPASS_ACTORS_PRESENT');
});

test('missing non-fast-forward rule is rejected', () => {
  const r = structuredClone(desired);
  r.rules = r.rules.filter((x) => x.type !== 'non_fast_forward');
  assert.equal(inspectAuthorityRuleset(r).classification, 'NON_FAST_FORWARD_RULE_MISSING');
});

test('missing deletion rule is rejected', () => {
  const r = structuredClone(desired);
  r.rules = r.rules.filter((x) => x.type !== 'deletion');
  assert.equal(inspectAuthorityRuleset(r).classification, 'DELETION_RULE_MISSING');
});

test('force probe passes only when rewrite is rejected, head stays put and fast-forward still works', () => {
  const child = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.deepEqual(classifyForceProbe({
    childCommit: child,
    observedHeadAfterForceAttempt: child,
    forceMutationStatus: 'rejected',
    subsequentFastForwardSucceeded: true,
  }), {
    accepted: true,
    classification: 'PASS_GITHUB_SERVER_SIDE_NON_REWIND_FORCE_PROBE',
  });
});

test('force probe rejects an observed rewind even when mutation API reported an error', () => {
  assert.equal(classifyForceProbe({
    childCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    observedHeadAfterForceAttempt: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    forceMutationStatus: 'rejected',
    subsequentFastForwardSucceeded: true,
  }).classification, 'FAIL_FORCE_REWRITE_OBSERVED');
});

test('force probe rejects reported success even if reread unexpectedly stayed at child', () => {
  const child = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(classifyForceProbe({
    childCommit: child,
    observedHeadAfterForceAttempt: child,
    forceMutationStatus: 'succeeded',
    subsequentFastForwardSucceeded: true,
  }).classification, 'FAIL_FORCE_MUTATION_REPORTED_SUCCESS');
});

test('ruleset must not block normal monotonic authority advancement', () => {
  const child = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(classifyForceProbe({
    childCommit: child,
    observedHeadAfterForceAttempt: child,
    forceMutationStatus: 'rejected',
    subsequentFastForwardSucceeded: false,
  }).classification, 'FAIL_MONOTONIC_ADVANCE_BLOCKED');
});
