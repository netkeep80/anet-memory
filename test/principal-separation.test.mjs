import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('principal separation: shared control/admin capability defeats stale-writer fencing', () => {
  const suite='experiments/commit-boundary/principal-separation';
  const run=spawnSync('python3',['-W','error::ResourceWarning','-m','unittest','discover','-s',suite,'-p','test_principal_separation.py','-v'],{
    encoding:'utf8', timeout:90_000, maxBuffer:4*1024*1024,
  });
  assert.equal(run.error,undefined,run.error?.message);
  assert.equal(run.status,0,`principal separation suite failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr,/Ran 10 tests/);
  assert.match(run.stderr,/\bOK\b/);
});
