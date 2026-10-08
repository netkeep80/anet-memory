#!/usr/bin/env python3
"""Research-only authenticated downstream cutover sink.

All "effects" are synthetic SQLite receipts/counter increments.  This model is
only evidence for a downstream service whose own commit point atomically checks
writer authority, generation fencing, and idempotency.  It is NOT permission to
execute arbitrary external effects.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import signal
import sqlite3
from contextlib import closing
from pathlib import Path

SCHEMA = "anet-authenticated-effect-cutover/research-1"


class SinkError(RuntimeError):
    pass


def connect(path: Path | str):
    con = sqlite3.connect(str(path), timeout=30, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=FULL")
    con.execute("PRAGMA busy_timeout=30000")
    return con


def init(path):
    with closing(connect(path)) as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS authority(
          scope TEXT PRIMARY KEY,
          generation INTEGER NOT NULL,
          commit_sha TEXT NOT NULL,
          secret_hex TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('ACTIVE','ROTATED'))
        );
        CREATE TABLE IF NOT EXISTS effects(
          scope TEXT NOT NULL,
          effect_key TEXT NOT NULL,
          generation INTEGER NOT NULL,
          commit_sha TEXT NOT NULL,
          payload_sha256 TEXT NOT NULL,
          PRIMARY KEY(scope,effect_key)
        );
        CREATE TABLE IF NOT EXISTS counters(
          scope TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        """)
    return {"state":"INITIALIZED","schema":SCHEMA}


def _commit_ok(value):
    return isinstance(value,str) and len(value)==40 and all(c in '0123456789abcdef' for c in value)


def _secret_ok(secret_hex):
    try:
        return len(bytes.fromhex(secret_hex)) >= 16
    except Exception:
        return False


def _payload_sha(payload: bytes):
    return hashlib.sha256(payload).hexdigest()


def _message(scope,generation,commit_sha,effect_key,payload_sha256):
    return json.dumps({
        "scope":scope,"generation":generation,"commit_sha":commit_sha,
        "effect_key":effect_key,"payload_sha256":payload_sha256,
    }, sort_keys=True, separators=(',',':')).encode()


def sign(secret_hex, scope, generation, commit_sha, effect_key, payload: bytes):
    digest=_payload_sha(payload)
    return hmac.new(bytes.fromhex(secret_hex), _message(scope,generation,commit_sha,effect_key,digest), hashlib.sha256).hexdigest()


def install(path, scope, generation, commit_sha, secret_hex):
    if generation != 1 or not _commit_ok(commit_sha) or not _secret_ok(secret_hex):
        raise SinkError("INVALID_AUTHORITY")
    with closing(connect(path)) as con:
        con.execute("BEGIN IMMEDIATE")
        try:
            row=con.execute("SELECT * FROM authority WHERE scope=?",(scope,)).fetchone()
            if row:
                raise SinkError("AUTHORITY_ALREADY_EXISTS")
            con.execute("INSERT INTO authority(scope,generation,commit_sha,secret_hex,phase) VALUES(?,?,?,?, 'ACTIVE')",
                        (scope,generation,commit_sha,secret_hex))
            con.execute("INSERT OR IGNORE INTO counters(scope,value) VALUES(?,0)",(scope,))
            con.execute("COMMIT")
        except Exception:
            if con.in_transaction: con.execute("ROLLBACK")
            raise
    return {"state":"AUTHORITY_INSTALLED","generation":generation}


def rotate(path, scope, expected_generation, expected_commit, new_generation, new_commit, new_secret_hex,
           failpoint=None):
    if new_generation != expected_generation + 1 or not _commit_ok(new_commit) or not _secret_ok(new_secret_hex):
        raise SinkError("INVALID_ROTATION")
    with closing(connect(path)) as con:
        con.execute("BEGIN IMMEDIATE")
        try:
            row=con.execute("SELECT * FROM authority WHERE scope=?",(scope,)).fetchone()
            if not row: raise SinkError("NO_AUTHORITY")
            if row['generation'] != expected_generation or row['commit_sha'] != expected_commit:
                raise SinkError("AUTHORITY_CAS_MISMATCH")
            con.execute("UPDATE authority SET generation=?,commit_sha=?,secret_hex=?,phase='ROTATED' WHERE scope=?",
                        (new_generation,new_commit,new_secret_hex,scope))
            if failpoint == 'before-commit': os.kill(os.getpid(), signal.SIGKILL)
            con.execute("COMMIT")
            if failpoint == 'after-commit-before-ack': os.kill(os.getpid(), signal.SIGKILL)
        except Exception:
            if con.in_transaction: con.execute("ROLLBACK")
            raise
    return {"state":"AUTHORITY_ROTATED","generation":new_generation}


def apply(path, scope, generation, commit_sha, effect_key, payload: bytes, signature, failpoint=None):
    digest=_payload_sha(payload)
    with closing(connect(path)) as con:
        con.execute("BEGIN IMMEDIATE")
        try:
            row=con.execute("SELECT * FROM authority WHERE scope=?",(scope,)).fetchone()
            if not row: raise SinkError("NO_AUTHORITY")
            expected=sign(row['secret_hex'],scope,generation,commit_sha,effect_key,payload)
            if not hmac.compare_digest(expected,signature): raise SinkError("UNAUTHENTICATED_WRITER")
            if generation != row['generation'] or commit_sha != row['commit_sha']:
                raise SinkError("STALE_AUTHORITY")
            existing=con.execute("SELECT * FROM effects WHERE scope=? AND effect_key=?",(scope,effect_key)).fetchone()
            if existing:
                same=(existing['generation']==generation and existing['commit_sha']==commit_sha and
                      existing['payload_sha256']==digest)
                if same:
                    con.execute("COMMIT")
                    return {"state":"ALREADY_APPLIED","payload_sha256":digest}
                raise SinkError("IDEMPOTENCY_KEY_CONFLICT")
            con.execute("INSERT INTO effects(scope,effect_key,generation,commit_sha,payload_sha256) VALUES(?,?,?,?,?)",
                        (scope,effect_key,generation,commit_sha,digest))
            con.execute("UPDATE counters SET value=value+1 WHERE scope=?",(scope,))
            if failpoint == 'before-commit': os.kill(os.getpid(), signal.SIGKILL)
            con.execute("COMMIT")
            if failpoint == 'after-commit-before-ack': os.kill(os.getpid(), signal.SIGKILL)
        except Exception:
            if con.in_transaction: con.execute("ROLLBACK")
            raise
    return {"state":"APPLIED","payload_sha256":digest}


def state(path,scope):
    with closing(connect(path)) as con:
        a=con.execute("SELECT generation,commit_sha,phase FROM authority WHERE scope=?",(scope,)).fetchone()
        c=con.execute("SELECT value FROM counters WHERE scope=?",(scope,)).fetchone()
        effects=[dict(r) for r in con.execute("SELECT scope,effect_key,generation,commit_sha,payload_sha256 FROM effects WHERE scope=? ORDER BY effect_key",(scope,))]
    return {"authority":dict(a) if a else None,"counter":c['value'] if c else 0,"effects":effects}


def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='op',required=True)
    for op in ('init','install','rotate','apply','state'):
        q=sub.add_parser(op); q.add_argument('--db',required=True); q.add_argument('--scope',default='research')
        if op=='install':
            q.add_argument('--generation',type=int,required=True); q.add_argument('--commit',required=True); q.add_argument('--secret',required=True)
        elif op=='rotate':
            q.add_argument('--expected-generation',type=int,required=True); q.add_argument('--expected-commit',required=True); q.add_argument('--new-generation',type=int,required=True); q.add_argument('--new-commit',required=True); q.add_argument('--new-secret',required=True); q.add_argument('--failpoint')
        elif op=='apply':
            q.add_argument('--generation',type=int,required=True); q.add_argument('--commit',required=True); q.add_argument('--effect-key',required=True); q.add_argument('--payload',required=True); q.add_argument('--signature',required=True); q.add_argument('--failpoint')
    a=p.parse_args(); db=Path(a.db)
    try:
        if a.op=='init': result=init(db)
        elif a.op=='install': result=install(db,a.scope,a.generation,a.commit,a.secret)
        elif a.op=='rotate': result=rotate(db,a.scope,a.expected_generation,a.expected_commit,a.new_generation,a.new_commit,a.new_secret,a.failpoint)
        elif a.op=='apply': result=apply(db,a.scope,a.generation,a.commit,a.effect_key,a.payload.encode(),a.signature,a.failpoint)
        else: result=state(db,a.scope)
        print(json.dumps(result,sort_keys=True))
    except SinkError as e:
        print(json.dumps({"state":"REFUSED","reason":str(e)},sort_keys=True)); raise SystemExit(2)

if __name__=='__main__': main()
