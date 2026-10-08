import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('stale selector containment: stale state cannot authorize effects through the current fenced sink', () => {
  const suite='experiments/commit-boundary/stale-selector-containment';
  const run=spawnSync('python3',['-W','error::ResourceWarning','-m','unittest','discover','-s',suite,'-p','test_stale_selector_containment.py','-v'],{encoding:'utf8',timeout:90_000,maxBuffer:4*1024*1024});
  assert.equal(run.error,undefined,run.error?.message);
  assert.equal(run.status,0,`stale selector containment suite failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr,/Ran 12 tests/);
  assert.match(run.stderr,/\bOK\b/);
});
