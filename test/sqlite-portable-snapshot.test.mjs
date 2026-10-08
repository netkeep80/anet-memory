import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Research-only integration: Python stdlib SQLite ONLINE BACKUP, not ChatGPT Library.
// Real cross-chat consumer must independently materialize and run the pinned source.
test('SQLite online backup captures WAL-only commit while plain .db copy loses it', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'anet-portable-snapshot-'));
  const script = String.raw`
import json
import pathlib
import shutil
import sqlite3
import sys
sys.path.insert(0, sys.argv[1])
from portable_snapshot import make_snapshot, verify_snapshot, state
root = pathlib.Path(sys.argv[2])
db = root/'live.sqlite'
manifest = root/'snapshot.json'
safe = root/'portable-snapshot.sqlite'
unsafe = root/'unsafe.sqlite'
con = sqlite3.connect(db)
con.execute('PRAGMA journal_mode=WAL')
con.execute('PRAGMA synchronous=FULL')
con.execute('PRAGMA wal_autocheckpoint=0')
con.executescript("""
CREATE TABLE authority (scope TEXT PRIMARY KEY, generation INTEGER NOT NULL, commit_sha TEXT NOT NULL);
CREATE TABLE effects (scope TEXT NOT NULL, effect_key TEXT NOT NULL, generation INTEGER NOT NULL, commit_sha TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (scope,effect_key));
CREATE TABLE counters (scope TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO authority VALUES ('run-54',2,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
INSERT INTO effects VALUES ('run-54','first',2,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','digest-1');
INSERT INTO counters VALUES ('run-54',1);
""")
con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
con.execute("INSERT INTO effects VALUES ('run-54','second',2,?,?)",('b'*40,'digest-2'))
con.execute("UPDATE counters SET value=2 WHERE scope='run-54'")
con.commit()
# The live writer stays open and retains the uncheckpointed WAL.
wal = pathlib.Path(str(db)+'-wal')
assert wal.exists() and wal.stat().st_size > 0
shutil.copyfile(db, unsafe)
with sqlite3.connect(unsafe) as uns:
    stale = state(uns,'run-54')
assert (stale['count'],stale['effects'])==(1,1),stale
record = make_snapshot(db,safe,manifest,'run-54','ci-test')
assert (record['state']['count'],record['state']['effects'])==(2,2),record
assert verify_snapshot(safe,manifest,'run-54')['state']=='SNAPSHOT_VERIFIED'
bad = root/'tampered'/'portable-snapshot.sqlite'
bad.parent.mkdir()
blob=bytearray(safe.read_bytes())
blob[4096+12] ^= 0x01
bad.write_bytes(blob)
try:
    verify_snapshot(bad, manifest, 'run-54')
except ValueError as exc:
    assert str(exc)=='SHA256_MISMATCH'
else:
    raise AssertionError('tampered bytes accepted')
con.close()
print(json.dumps({'classification':'PASS_PORTABLE_SNAPSHOT_WAL',
  'unsafe_effects':stale['effects'],
  'backup_effects':record['state']['effects'],
  'tamper_rejected':True}))
`;
  try {
    const out = execFileSync('python3', ['-c', script,
      resolve('experiments/commit-boundary/sqlite-portable'), scratch],
      { encoding: 'utf8', timeout: 20000 });
    const result = JSON.parse(out);
    assert.equal(result.classification, 'PASS_PORTABLE_SNAPSHOT_WAL');
    assert.equal(result.unsafe_effects, 1);
    assert.equal(result.backup_effects, 2);
    assert.equal(result.tamper_rejected, true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('two writable clones of one exact checkpoint both accept a new same effect key (falsifier)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'anet-sqlite-fork-'));
  const script = String.raw`
import json, pathlib, shutil, sqlite3, subprocess, sys
sys.path.insert(0,sys.argv[1])
from portable_snapshot import make_snapshot, verify_snapshot
root=pathlib.Path(sys.argv[2])
sink=pathlib.Path(sys.argv[3])
source=root/'original.sqlite'
snapshot=root/'portable-snapshot.sqlite'
manifest=root/'manifest.json'
copy=root/'restored.sqlite'
con=sqlite3.connect(source)
con.executescript("""
CREATE TABLE authority (scope TEXT PRIMARY KEY, generation INTEGER NOT NULL, commit_sha TEXT NOT NULL);
CREATE TABLE effects (scope TEXT NOT NULL, effect_key TEXT NOT NULL, generation INTEGER NOT NULL, commit_sha TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (scope,effect_key));
CREATE TABLE counters (scope TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO authority VALUES ('run-54',2,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
INSERT INTO counters VALUES ('run-54',0);
""")
con.close()
make_snapshot(source,snapshot,manifest,'run-54','ci-fork')
assert verify_snapshot(snapshot,manifest,'run-54')['state']=='SNAPSHOT_VERIFIED'
shutil.copyfile(snapshot,copy)
def apply(db):
    p=subprocess.run([sys.executable,str(sink),'--db',str(db),'apply',
      '--key','post-snapshot','--generation','2','--commit','b'*40],
      text=True,capture_output=True,timeout=8,check=True)
    return json.loads(p.stdout)['state']
first=apply(source)
second=apply(copy)
assert (first,second)==('APPLIED','APPLIED')
print(json.dumps({'classification':'DIVERGENT_SNAPSHOT_FALSIFIER','original':first,
    'restored':second,'external_effects':False}))
`;
  try {
    const out = execFileSync('python3', ['-c', script,
      resolve('experiments/commit-boundary/sqlite-portable'), scratch,
      resolve('experiments/commit-boundary/sqlite-crash/sqlite_effect_sink.py')],
      { encoding: 'utf8', timeout: 20000 });
    const result = JSON.parse(out);
    assert.equal(result.classification, 'DIVERGENT_SNAPSHOT_FALSIFIER');
    assert.equal(result.original, 'APPLIED');
    assert.equal(result.restored, 'APPLIED');
    assert.equal(result.external_effects, false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
