import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('live GitHub + Library evidence preserves strict classification', () => {
  const r = JSON.parse(readFileSync(
    'experiments/commit-boundary/github-library-generation/live-run-20261009-01/result.json',
    'utf8',
  ));

  assert.equal(r.schema, 'anet-github-library-generation-live/result-1');
  assert.equal(r.generation_2_candidates.A.cas_outcome, 'SUCCESS');
  assert.equal(
    r.generation_2_candidates.B.cas_outcome,
    'REJECTED_STALE_EXPECTED_HEAD_GENERIC_GRAPHQL_UNKNOWN',
  );

  assert.equal(
    r.authoritative_reread.head,
    r.generation_2_candidates.A.commit,
  );
  assert.equal(
    r.authoritative_reread.selected_file_id,
    r.generation_2_candidates.A.root.file_id,
  );
  assert.equal(
    r.authoritative_reread.consumer_readback_sha256,
    r.generation_2_candidates.A.root.sha256,
  );
  assert.equal(
    r.authoritative_reread.consumer_readback_size_bytes,
    r.generation_2_candidates.A.root.size_bytes,
  );
  assert.equal(r.authoritative_reread.exact_byte_verification, 'PASS');

  assert.equal(r.library_observation_after_race.candidate_A_visible, true);
  assert.equal(r.library_observation_after_race.candidate_B_visible, true);
  assert.equal(r.library_observation_after_race.losing_visible_candidate_is_committed, false);

  assert.equal(r.classification.same_chat_live_end_to_end, 'PASS');
  assert.equal(r.classification.library_exact_byte_roundtrip, 'PASS');
  assert.equal(r.classification.github_cas_single_winner, 'PASS');
  assert.equal(r.classification.visible_orphan_not_authoritative, 'PASS');
  assert.equal(r.classification.fresh_chat_cross_sandbox, 'PENDING');
  assert.equal(r.classification.server_side_non_rewind, 'NOT_PROVEN');
  assert.equal(r.classification.external_effects_allowed, false);
});
