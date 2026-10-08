import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('live Git ref authority evidence remains classified fail-closed', () => {
  const path = 'experiments/commit-boundary/ref-authority-live/result.json';
  const r = JSON.parse(readFileSync(path, 'utf8'));

  assert.equal(r.schema, 'anet-ref-authority-live/research-1');
  assert.equal(r.candidate_a.parent, r.base_commit);
  assert.equal(r.candidate_b.parent, r.candidate_a.commit);

  assert.equal(r.concurrent_race_refs.length, 8);
  for (const item of r.concurrent_race_refs) {
    assert.ok(
      item.final_head === r.candidate_a.commit || item.final_head === r.candidate_b.commit,
      `unexpected race head: ${item.final_head}`,
    );
  }

  assert.equal(r.stale_expected_fast_forward_attempts.length, 4);
  for (const item of r.stale_expected_fast_forward_attempts) {
    assert.equal(item.from, r.candidate_a.commit);
    assert.equal(item.to, r.candidate_b.commit);
    assert.equal(item.expected_sha, r.base_commit);
    assert.equal(item.force, false);
    assert.equal(item.outcome, 'REJECTED_GENERIC_GRAPHQL_UNKNOWN');
    assert.equal(item.head_unchanged, true);
  }

  assert.equal(r.rewind_probe.no_force.force, false);
  assert.equal(r.rewind_probe.no_force.outcome, 'REJECTED_UNPROCESSABLE_NON_FAST_FORWARD');
  assert.equal(r.rewind_probe.force, undefined);
  assert.equal(r.rewind_probe.forced.force, true);
  assert.equal(r.rewind_probe.forced.outcome, 'SUCCESS');
  assert.equal(r.rewind_probe.forced.head_after, r.base_commit);
  assert.equal(r.rewind_probe.restore.outcome, 'SUCCESS');
  assert.equal(r.rewind_probe.restore.head_after, r.candidate_a.commit);

  assert.deepEqual(r.repository_governance.rulesets, []);
  assert.equal(r.repository_governance.server_side_no_rewrite_protection_observed, false);

  assert.equal(r.classification.expected_head_fencing_observed, true);
  assert.equal(r.classification.clean_conflict_error_contract_proven, false);
  assert.equal(r.classification.non_rewind_authority, false);
  assert.equal(r.classification.designated_writer_authentication, false);
  assert.equal(r.classification.usable_as_production_effect_authority, false);
  assert.equal(r.classification.external_effects_allowed, false);
});
