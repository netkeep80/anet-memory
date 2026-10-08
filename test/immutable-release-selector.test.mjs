import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('immutable release selector contract stays fail-closed before platform experiment', () => {
  const suite='experiments/commit-boundary/immutable-release-selector';
  const run=spawnSync('python3',['-m','unittest','discover','-s',suite,'-p','test_selector_contract.py','-v'],{encoding:'utf8',timeout:60_000,maxBuffer:4*1024*1024});
  assert.equal(run.error,undefined,run.error?.message);
  assert.equal(run.status,0,`immutable selector contract failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr,/Ran 13 tests/);
  assert.match(run.stderr,/\bOK\b/);
});
