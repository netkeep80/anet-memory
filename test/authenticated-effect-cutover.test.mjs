import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('authenticated effect cutover: sink-side fencing linearizes in-flight synthetic effects', () => {
  const suite='experiments/commit-boundary/authenticated-effect-cutover';
  const run=spawnSync('python3',['-m','unittest','discover','-s',suite,'-p','test_authenticated_effect_sink.py','-v'],{encoding:'utf8',timeout:90_000,maxBuffer:4*1024*1024});
  assert.equal(run.error,undefined,run.error?.message);
  assert.equal(run.status,0,`authenticated effect cutover suite failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr,/Ran 13 tests/);
  assert.match(run.stderr,/\bOK\b/);
});
