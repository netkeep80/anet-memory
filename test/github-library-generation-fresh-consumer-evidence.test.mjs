import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('fresh consumer evidence remains strictly classified', () => {
  const r = JSON.parse(readFileSync(
    'experiments/commit-boundary/github-library-generation/live-run-20261009-01/fresh-consumer-result.json',
    'utf8',
  ));

  assert.equal(r.schema, 'anet-github-library-generation-fresh-consumer/result-1');
  assert.equal(r.authority.generation, 2);
  assert.equal(r.authority.generation_1.generation, 1);
  assert.equal(r.authority.generation_1.predecessor_commit, null);
  assert.equal(r.authority.predecessor_commit, r.authority.generation_1.commit);

  assert.equal(
    r.selected_library_object.file_id,
    'file_00000000d08882468c54a78dc4046a92',
  );
  assert.equal(r.selected_library_object.size_bytes, 209);
  assert.equal(
    r.selected_library_object.sha256,
    'da259f4a317dd52e651fb75b0aa5afa25548c3c88c66259eea651c6ddcade0cd',
  );

  assert.equal(r.independent_crosscheck_after_consumer_report.authority_head_matches, true);
  assert.equal(r.independent_crosscheck_after_consumer_report.generation_record_matches, true);
  assert.equal(r.independent_crosscheck_after_consumer_report.materialized_file_id_matches, true);
  assert.equal(r.independent_crosscheck_after_consumer_report.exact_bytes_match, true);

  assert.equal(r.classification.fresh_chat_replay, 'PASS');
  assert.equal(r.classification.different_sandbox, 'NOT_PROVEN');
  assert.equal(r.classification.selected_library_exact_bytes, 'PASS');
  assert.equal(r.classification.git_chain_valid, 'PASS');
  assert.equal(r.classification.server_side_non_rewind, 'NOT_PROVEN');
  assert.equal(r.classification.external_effects_allowed, false);
});
