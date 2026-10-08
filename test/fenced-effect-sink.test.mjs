import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('fenced effect sink: credentialed authority rotation fences in-flight synthetic effects', () => {
  const suite = 'experiments/commit-boundary/fenced-effect-sink';
  const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', suite, '-p', 'test_fenced_effect_sink.py', '-v'], {
    encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, `fenced effect sink research suite failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /Ran 13 tests/);
  assert.match(run.stderr, /\bOK\b/);
});
