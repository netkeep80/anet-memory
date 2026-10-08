import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('two-store cutover: durable outbox + sink freeze + receipt reconciliation fail closed', () => {
  const suite = 'experiments/commit-boundary/two-store-cutover';
  const run = spawnSync('python3', ['-m','unittest','discover','-s',suite,'-p','test_two_store_cutover.py','-v'], {
    encoding:'utf8', timeout:90_000, maxBuffer:4*1024*1024,
  });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, `two-store cutover research failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr,/Ran 17 tests/);
  assert.match(run.stderr,/\bOK\b/);
});
