import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('checkpoint journal falsifiers and real SQLite SIGKILL replay', () => {
  const result = spawnSync('python3', [
    'experiments/commit-boundary/journal-cutover/test_cutover_journal.py',
  ], { encoding: 'utf8', timeout: 45000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0,
    `journal test failed (signal=${result.signal}):\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 16 tests/);
  assert.match(result.stderr, /OK/);
});
