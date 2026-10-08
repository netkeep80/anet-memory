import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('cutover race: real SQLite subprocess fencing and catch-up are fail-closed', () => {
  const suite = 'experiments/commit-boundary/cutover-race';
  const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', suite, '-p', 'test_cutover_race.py', '-v'], {
    encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, `SQLite cutover research suite failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /Ran 12 tests/);
  assert.match(run.stderr, /\bOK\b/);
});
