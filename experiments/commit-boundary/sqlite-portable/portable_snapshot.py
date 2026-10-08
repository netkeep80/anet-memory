#!/usr/bin/env python3
"""Research only: consistent SQLite ONLINE backup with exact-byte evidence manifest.

No GitHub/Library API, no authority grant, no external side effect.  Caller
must publish both files separately, verify exact hashes and use a new sandbox.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
from datetime import datetime, timezone


def sha256(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def state(conn, scope):
    check = conn.execute('PRAGMA integrity_check').fetchone()[0]
    if check != 'ok':
        raise RuntimeError('INTEGRITY_CHECK_FAILED')
    auth = conn.execute('SELECT generation,commit_sha FROM authority WHERE scope=?',(scope,)).fetchone()
    value = conn.execute('SELECT value FROM counters WHERE scope=?',(scope,)).fetchone()
    rows = conn.execute('SELECT effect_key,generation,commit_sha,digest FROM effects WHERE scope=? ORDER BY effect_key',(scope,)).fetchall()
    if auth is None or value is None or value[0]!=len(rows):
        raise RuntimeError('STATE_INCONSISTENT')
    return {'generation':auth[0], 'commit_sha':auth[1], 'count':value[0], 'effects':len(rows), 'effects_sha256':hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest(), 'integrity_check':check}


def make_snapshot(source, dest, manifest_path, scope, run_id):
    source,dest,manifest_path=map(Path,(source,dest,manifest_path))
    if source.resolve()==dest.resolve(): raise ValueError('DEST_EQUALS_SOURCE')
    if dest.exists() or manifest_path.exists(): raise FileExistsError('OUTPUT_MUST_BE_NEW')
    dest.parent.mkdir(parents=True, exist_ok=True)
    # sqlite3.Connection.backup() creates a consistent transaction snapshot,
    # including transactions still present only in the active WAL file.
    with sqlite3.connect(f'file:{source}?mode=ro',uri=True) as src:
        expected=state(src,scope)
        with sqlite3.connect(dest) as out:
            src.backup(out, pages=0)
    with sqlite3.connect(f'file:{dest}?mode=ro',uri=True) as copied:
        actual=state(copied,scope)
    if expected!=actual: raise RuntimeError('SNAPSHOT_STATE_MISMATCH')
    evidence={
      'protocol':'anet-sqlite-portable-snapshot/research-1','run_id':run_id,
      'created_utc':datetime.now(timezone.utc).isoformat(),
      'filename':dest.name,'size_bytes':dest.stat().st_size,
      'sha256':sha256(dest),'state':actual,
      'source_generation_claim':'CALLER_PROVIDED_UNAUTHENTICATED',
      'authority_verification':'NOT_PROVEN','external_effects_allowed':False,
      'snapshot_method':'sqlite3.Connection.backup; consistent transaction snapshot',
      'cross_sandbox_accepted':False
    }
    manifest_path.write_text(json.dumps(evidence,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    return evidence


def verify_snapshot(snapshot,manifest,scope):
    snapshot=Path(snapshot); info=json.loads(Path(manifest).read_text(encoding='utf-8'))
    if info.get('protocol')!='anet-sqlite-portable-snapshot/research-1': raise ValueError('INVALID_MANIFEST_PROTOCOL')
    if snapshot.name!=info['filename']: raise ValueError('FILENAME_MISMATCH')
    if snapshot.stat().st_size!=info['size_bytes']: raise ValueError('SIZE_MISMATCH')
    if sha256(snapshot)!=info['sha256']: raise ValueError('SHA256_MISMATCH')
    with sqlite3.connect(f'file:{snapshot}?mode=ro',uri=True) as conn:
        s=state(conn,scope)
    if s!=info['state']: raise ValueError('STATE_MISMATCH')
    if info.get('external_effects_allowed') is not False: raise ValueError('UNSAFE_EFFECTS_ALLOWED')
    return {'state':'SNAPSHOT_VERIFIED','snapshot_sha256':info['sha256'],'authority':'UNVERIFIED','external_effects_allowed':False,'details':s}


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=['make','verify'])
    p.add_argument('--db',required=True)
    p.add_argument('--manifest',required=True)
    p.add_argument('--scope',default='run-54')
    p.add_argument('--run-id',default='sqlite-portable-20261008-01')
    args=p.parse_args()
    if args.action=='make': out=make_snapshot(args.db,args.db+'.backup' if False else str(Path(args.db).parent/'portable-snapshot.sqlite'),args.manifest,args.scope,args.run_id)
    else: out=verify_snapshot(args.db,args.manifest,args.scope)
    print(json.dumps(out,indent=2,sort_keys=True))
