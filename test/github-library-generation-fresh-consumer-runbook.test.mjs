import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('fresh consumer runbook does not leak live winner or loser identities', () => {
  const runbook = readFileSync(
    'experiments/commit-boundary/github-library-generation/live-run-20261009-01/CONSUMER.md',
    'utf8',
  );
  const evidence = JSON.parse(readFileSync(
    'experiments/commit-boundary/github-library-generation/live-run-20261009-01/result.json',
    'utf8',
  ));

  const forbidden = new Set([
    evidence.generation_1.commit,
    evidence.generation_1.root.file_id,
    evidence.generation_1.root.sha256,
    evidence.generation_2_candidates.A.commit,
    evidence.generation_2_candidates.A.root.file_id,
    evidence.generation_2_candidates.A.root.sha256,
    evidence.generation_2_candidates.B.commit,
    evidence.generation_2_candidates.B.root.file_id,
    evidence.generation_2_candidates.B.root.sha256,
    evidence.authoritative_reread.head,
    evidence.authoritative_reread.selected_file_id,
    evidence.authoritative_reread.consumer_readback_sha256,
  ]);

  for (const value of forbidden) {
    assert.ok(value, 'evidence value must exist');
    assert.equal(
      runbook.includes(value),
      false,
      `fresh consumer runbook leaked live evidence value: ${value}`,
    );
  }

  assert.match(
    runbook,
    /refs\/heads\/research\/github-library-live-authority-20261009-01/,
  );
  assert.match(
    runbook,
    /experiments\/commit-boundary\/evidence\/github-library-generation-live-20261009-01\/generation\.json/,
  );
  assert.match(runbook, /INVALID_ISOLATION_CONTAMINATION/);
  assert.match(runbook, /PENDING_SELECTED_LIBRARY_OBJECT/);
  assert.match(runbook, /PASS_FRESH_CHAT_CURRENT_REF_SELECTED_LIBRARY_REPLAY/);
  assert.match(runbook, /SERVER_SIDE_NON_REWIND.*NOT_PROVEN/s);
  assert.match(runbook, /EXTERNAL_EFFECTS_ALLOWED.*false/s);
});
