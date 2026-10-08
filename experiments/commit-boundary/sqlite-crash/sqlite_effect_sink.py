#!/usr/bin/env python3
"""RESEARCH ONLY: atomic SQLite effect + unique key, not a production bus or authority."""
import argparse
import hashlib
import json
import os
import signal
import sqlite3


def response(state, **kwargs):
    print(json.dumps({"state": state, **kwargs}, sort_keys=True), flush=True)


def connect(path):
    conn = sqlite3.connect(path, timeout=30, isolation_level=None)
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    return conn


def run(args):
    c = connect(args.db)
    if args.op == "init":
        c.executescript("""
        CREATE TABLE IF NOT EXISTS authority (
          scope TEXT PRIMARY KEY, generation INTEGER NOT NULL, commit_sha TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS effects (
          scope TEXT NOT NULL, effect_key TEXT NOT NULL, generation INTEGER NOT NULL,
          commit_sha TEXT NOT NULL, digest TEXT NOT NULL,
          PRIMARY KEY(scope,effect_key));
        CREATE TABLE IF NOT EXISTS counters (scope TEXT PRIMARY KEY, value INTEGER NOT NULL);
        """)
        response("READY", sqlite_version=sqlite3.sqlite_version)
        return
    if args.op == "state":
        x = c.execute("SELECT generation,commit_sha FROM authority WHERE scope=?", (args.scope,)).fetchone()
        v = c.execute("SELECT value FROM counters WHERE scope=?", (args.scope,)).fetchone()
        n = c.execute("SELECT count(*) FROM effects WHERE scope=?", (args.scope,)).fetchone()[0]
        response("STATE", generation=x[0] if x else None, commit_sha=x[1] if x else None, count=v[0] if v else 0, effects=n)
        return
    c.execute("BEGIN IMMEDIATE")
    row = c.execute("SELECT generation,commit_sha FROM authority WHERE scope=?", (args.scope,)).fetchone()
    if args.op == "install":
        if row and args.generation < row[0]:
            c.execute("ROLLBACK"); response("STALE_AUTHORITY"); return
        if row and args.generation == row[0]:
            c.execute("ROLLBACK")
            response("AUTHORITY_ALREADY_INSTALLED" if row[1] == args.commit else "AUTHORITY_FORK")
            return
        c.execute("INSERT INTO authority(scope,generation,commit_sha) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET generation=excluded.generation,commit_sha=excluded.commit_sha", (args.scope,args.generation,args.commit))
        c.execute("COMMIT"); response("AUTHORITY_INSTALLED"); return
    if args.op != "apply":
        raise ValueError(args.op)
    if not row:
        c.execute("ROLLBACK"); response("NO_AUTHORITY"); return
    if args.generation != row[0]:
        c.execute("ROLLBACK"); response("STALE_OR_FUTURE_GENERATION"); return
    if args.commit != row[1]:
        c.execute("ROLLBACK"); response("WRONG_COMMIT"); return
    data = bytes.fromhex(args.payload_hex)
    digest = hashlib.sha256(data).hexdigest()
    old = c.execute("SELECT generation,commit_sha,digest FROM effects WHERE scope=? AND effect_key=?", (args.scope,args.key)).fetchone()
    if old:
        c.execute("ROLLBACK")
        response("ALREADY_APPLIED" if old == (args.generation,args.commit,digest) else "IDEMPOTENCY_KEY_CONFLICT", digest=digest)
        return
    c.execute("INSERT INTO effects VALUES (?,?,?,?,?)", (args.scope,args.key,args.generation,args.commit,digest))
    c.execute("INSERT INTO counters(scope,value) VALUES (?,1) ON CONFLICT(scope) DO UPDATE SET value=value+1", (args.scope,))
    if args.failpoint == "before-commit":
        os.kill(os.getpid(), signal.SIGKILL)
    c.execute("COMMIT")
    if args.failpoint == "after-commit-before-ack":
        os.kill(os.getpid(), signal.SIGKILL)
    response("APPLIED", digest=digest)


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--db", required=True)
    a.add_argument("op", choices=["init", "state", "install", "apply"])
    a.add_argument("--scope", default="run-54")
    a.add_argument("--generation", type=int, default=1)
    a.add_argument("--commit", default="a"*40)
    a.add_argument("--key", default="effect-1")
    a.add_argument("--payload-hex", default="68656c6c6f")
    a.add_argument("--failpoint", choices=["before-commit", "after-commit-before-ack"])
    run(a.parse_args())
