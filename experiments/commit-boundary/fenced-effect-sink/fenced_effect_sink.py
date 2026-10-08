#!/usr/bin/env python3
"""Research-only fenced synthetic effect sink.

One SQLite database represents the downstream sink's private transactional state.
Writer/control credentials are HMAC research credentials. No network service and
no real external side effect is performed.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
from typing import Any

ZERO = "0" * 64
SCHEMA = "anet-fenced-effect-sink/research-1"


class SinkError(RuntimeError):
    pass


def canonical(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def mac(secret: str, obj: dict[str, Any]) -> str:
    return hmac.new(bytes.fromhex(secret), canonical(obj), hashlib.sha256).hexdigest()


@contextmanager
def connect(db: Path | str):
    con = sqlite3.connect(str(db), timeout=20, isolation_level=None)
    try:
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=FULL")
        con.execute("PRAGMA foreign_keys=ON")
        yield con
    finally:
        con.close()


def _valid_id(name: str, value: str) -> None:
    if not value or len(value) > 200 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-" for c in value):
        raise SinkError(f"INVALID_{name.upper()}")


def _secret(value: str) -> None:
    if len(value) != 64:
        raise SinkError("INVALID_SECRET")
    try:
        bytes.fromhex(value)
    except ValueError as exc:
        raise SinkError("INVALID_SECRET") from exc


def _schema(con: sqlite3.Connection) -> None:
    con.executescript("""
    CREATE TABLE IF NOT EXISTS sink_config(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      schema_name TEXT NOT NULL,
      control_secret TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS writer_keys(
      writer_id TEXT PRIMARY KEY,
      secret TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS authority(
      scope TEXT PRIMARY KEY,
      generation INTEGER NOT NULL CHECK(generation>=1),
      writer_id TEXT NOT NULL,
      rotation_request_id TEXT,
      FOREIGN KEY(writer_id) REFERENCES writer_keys(writer_id)
    );
    CREATE TABLE IF NOT EXISTS effects(
      scope TEXT NOT NULL,
      effect_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      writer_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      receipt_seq INTEGER NOT NULL UNIQUE,
      receipt_hash TEXT NOT NULL,
      PRIMARY KEY(scope,effect_key)
    );
    CREATE TABLE IF NOT EXISTS ledger(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      generation INTEGER NOT NULL,
      writer_id TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      effect_key TEXT,
      payload_sha256 TEXT,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS rotations(
      request_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      from_generation INTEGER NOT NULL,
      to_generation INTEGER NOT NULL,
      from_writer_id TEXT NOT NULL,
      to_writer_id TEXT NOT NULL,
      receipt_seq INTEGER NOT NULL,
      receipt_hash TEXT NOT NULL
    );
    """)


def init(db: Path | str, scope: str, control_secret: str, writer1: str, secret1: str, writer2: str, secret2: str) -> dict:
    for n,v in (("scope",scope),("writer_id",writer1),("writer_id",writer2)):
        _valid_id(n,v)
    for s in (control_secret,secret1,secret2): _secret(s)
    with connect(db) as con:
        _schema(con)
        con.execute("BEGIN IMMEDIATE")
        try:
            if con.execute("SELECT 1 FROM sink_config").fetchone():
                raise SinkError("ALREADY_INITIALIZED")
            con.execute("INSERT INTO sink_config VALUES(1,?,?)", (SCHEMA,control_secret))
            con.execute("INSERT INTO writer_keys VALUES(?,?),(?,?)", (writer1,secret1,writer2,secret2))
            con.execute("INSERT INTO authority VALUES(?,?,?,NULL)", (scope,1,writer1))
            con.commit()
        except Exception:
            con.rollback(); raise
    return state(db,scope)


def apply_claim(scope: str, generation: int, writer_id: str, request_id: str, effect_key: str, payload: bytes) -> dict:
    for n,v in (("scope",scope),("writer_id",writer_id),("request_id",request_id),("effect_key",effect_key)):_valid_id(n,v)
    if generation < 1: raise SinkError("INVALID_GENERATION")
    return {"op":"apply","scope":scope,"generation":generation,"writer_id":writer_id,"request_id":request_id,
            "effect_key":effect_key,"payload_sha256":digest_bytes(payload)}


def rotation_claim(scope: str, expected_generation: int, expected_writer_id: str, next_generation: int, next_writer_id: str, request_id: str) -> dict:
    for n,v in (("scope",scope),("writer_id",expected_writer_id),("writer_id",next_writer_id),("request_id",request_id)):_valid_id(n,v)
    return {"op":"rotate","scope":scope,"expected_generation":expected_generation,"expected_writer_id":expected_writer_id,
            "next_generation":next_generation,"next_writer_id":next_writer_id,"request_id":request_id}


def sign_apply(secret: str, claim: dict) -> str:
    _secret(secret); return mac(secret,claim)


def sign_rotation(control_secret: str, claim: dict) -> str:
    _secret(control_secret); return mac(control_secret,claim)


def _head(con: sqlite3.Connection) -> str:
    row=con.execute("SELECT entry_hash FROM ledger ORDER BY seq DESC LIMIT 1").fetchone()
    return row[0] if row else ZERO


def _append(con: sqlite3.Connection, *, kind: str, scope: str, generation: int, writer_id: str, request_id: str,
            effect_key: str|None=None, payload_sha256: str|None=None) -> tuple[int,str]:
    prev=_head(con)
    body={"kind":kind,"scope":scope,"generation":generation,"writer_id":writer_id,"request_id":request_id,
          "effect_key":effect_key,"payload_sha256":payload_sha256,"prev_hash":prev}
    entry=digest_bytes(canonical(body))
    cur=con.execute("INSERT INTO ledger(kind,scope,generation,writer_id,request_id,effect_key,payload_sha256,prev_hash,entry_hash) VALUES(?,?,?,?,?,?,?,?,?)",
                    (kind,scope,generation,writer_id,request_id,effect_key,payload_sha256,prev,entry))
    return int(cur.lastrowid),entry


def apply(db: Path|str, claim: dict, signature: str, *, failpoint: str|None=None) -> dict:
    payload_sha=claim.get("payload_sha256")
    with connect(db) as con:
        _schema(con)
        key=con.execute("SELECT secret FROM writer_keys WHERE writer_id=?",(claim.get("writer_id"),)).fetchone()
        if not key or not hmac.compare_digest(mac(key[0],claim),signature):
            raise SinkError("AUTH_FAILED")
        con.execute("BEGIN IMMEDIATE")
        try:
            a=con.execute("SELECT generation,writer_id FROM authority WHERE scope=?",(claim["scope"],)).fetchone()
            if not a: raise SinkError("NO_AUTHORITY")
            if int(a[0]) != int(claim["generation"]) or a[1] != claim["writer_id"]:
                raise SinkError("STALE_AUTHORITY")
            old=con.execute("SELECT * FROM effects WHERE scope=? AND effect_key=?",(claim["scope"],claim["effect_key"])).fetchone()
            if old:
                if old["payload_sha256"]==payload_sha and old["generation"]==claim["generation"] and old["writer_id"]==claim["writer_id"]:
                    con.rollback()
                    return {"state":"ALREADY_APPLIED","receipt_seq":old["receipt_seq"],"receipt_hash":old["receipt_hash"]}
                raise SinkError("IDEMPOTENCY_KEY_CONFLICT")
            seq,eh=_append(con,kind="EFFECT_APPLIED",scope=claim["scope"],generation=claim["generation"],writer_id=claim["writer_id"],
                           request_id=claim["request_id"],effect_key=claim["effect_key"],payload_sha256=payload_sha)
            con.execute("INSERT INTO effects VALUES(?,?,?,?,?,?,?,?)",(claim["scope"],claim["effect_key"],claim["generation"],claim["writer_id"],claim["request_id"],payload_sha,seq,eh))
            if failpoint=="before-commit": os.kill(os.getpid(), signal.SIGKILL)
            con.commit()
            if failpoint=="after-commit-before-ack": os.kill(os.getpid(), signal.SIGKILL)
            return {"state":"APPLIED","receipt_seq":seq,"receipt_hash":eh}
        except Exception:
            if con.in_transaction: con.rollback()
            raise


def rotate(db: Path|str, claim: dict, signature: str, *, failpoint: str|None=None) -> dict:
    with connect(db) as con:
        _schema(con)
        cfg=con.execute("SELECT control_secret FROM sink_config WHERE singleton=1").fetchone()
        if not cfg or not hmac.compare_digest(mac(cfg[0],claim),signature): raise SinkError("CONTROL_AUTH_FAILED")
        con.execute("BEGIN IMMEDIATE")
        try:
            prior=con.execute("SELECT * FROM rotations WHERE request_id=?",(claim["request_id"],)).fetchone()
            if prior:
                same=(prior["scope"]==claim["scope"] and prior["from_generation"]==claim["expected_generation"] and prior["to_generation"]==claim["next_generation"]
                      and prior["from_writer_id"]==claim["expected_writer_id"] and prior["to_writer_id"]==claim["next_writer_id"])
                if not same: raise SinkError("ROTATION_REQUEST_CONFLICT")
                con.rollback(); return {"state":"AUTHORITY_ALREADY_INSTALLED","receipt_seq":prior["receipt_seq"],"receipt_hash":prior["receipt_hash"]}
            if claim["next_generation"] != claim["expected_generation"]+1: raise SinkError("NON_MONOTONIC_GENERATION")
            if not con.execute("SELECT 1 FROM writer_keys WHERE writer_id=?",(claim["next_writer_id"],)).fetchone(): raise SinkError("UNKNOWN_NEXT_WRITER")
            a=con.execute("SELECT generation,writer_id FROM authority WHERE scope=?",(claim["scope"],)).fetchone()
            if not a: raise SinkError("NO_AUTHORITY")
            if int(a[0]) != int(claim["expected_generation"]) or a[1] != claim["expected_writer_id"]: raise SinkError("AUTHORITY_CAS_MISMATCH")
            seq,eh=_append(con,kind="AUTHORITY_ROTATED",scope=claim["scope"],generation=claim["next_generation"],writer_id=claim["next_writer_id"],request_id=claim["request_id"])
            con.execute("UPDATE authority SET generation=?,writer_id=?,rotation_request_id=? WHERE scope=?",
                        (claim["next_generation"],claim["next_writer_id"],claim["request_id"],claim["scope"]))
            con.execute("INSERT INTO rotations VALUES(?,?,?,?,?,?,?,?)",(claim["request_id"],claim["scope"],claim["expected_generation"],claim["next_generation"],claim["expected_writer_id"],claim["next_writer_id"],seq,eh))
            if failpoint=="before-commit": os.kill(os.getpid(), signal.SIGKILL)
            con.commit()
            if failpoint=="after-commit-before-ack": os.kill(os.getpid(), signal.SIGKILL)
            return {"state":"AUTHORITY_INSTALLED","receipt_seq":seq,"receipt_hash":eh}
        except Exception:
            if con.in_transaction: con.rollback()
            raise


def state(db: Path|str, scope: str) -> dict:
    with connect(db) as con:
        _schema(con)
        a=con.execute("SELECT generation,writer_id,rotation_request_id FROM authority WHERE scope=?",(scope,)).fetchone()
        return {"schema":SCHEMA,"authority":dict(a) if a else None,
                "effect_count":con.execute("SELECT COUNT(*) FROM effects WHERE scope=?",(scope,)).fetchone()[0],
                "ledger_count":con.execute("SELECT COUNT(*) FROM ledger WHERE scope=?",(scope,)).fetchone()[0],
                "head":_head(con),"external_effects_allowed":False}


def ledger(db: Path|str, scope: str) -> list[dict]:
    with connect(db) as con:
        return [dict(r) for r in con.execute("SELECT * FROM ledger WHERE scope=? ORDER BY seq",(scope,))]


def main() -> None:
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest="cmd",required=True)
    pi=sub.add_parser("init"); pi.add_argument("--db",required=True); pi.add_argument("--scope",required=True); pi.add_argument("--control-secret",required=True); pi.add_argument("--writer1",required=True); pi.add_argument("--secret1",required=True); pi.add_argument("--writer2",required=True); pi.add_argument("--secret2",required=True)
    pa=sub.add_parser("apply"); pa.add_argument("--db",required=True); pa.add_argument("--claim",required=True); pa.add_argument("--signature",required=True); pa.add_argument("--failpoint")
    pr=sub.add_parser("rotate"); pr.add_argument("--db",required=True); pr.add_argument("--claim",required=True); pr.add_argument("--signature",required=True); pr.add_argument("--failpoint")
    ps=sub.add_parser("state"); ps.add_argument("--db",required=True); ps.add_argument("--scope",required=True)
    args=p.parse_args()
    try:
        if args.cmd=="init": out=init(Path(args.db),args.scope,args.control_secret,args.writer1,args.secret1,args.writer2,args.secret2)
        elif args.cmd=="apply": out=apply(Path(args.db),json.loads(args.claim),args.signature,failpoint=args.failpoint)
        elif args.cmd=="rotate": out=rotate(Path(args.db),json.loads(args.claim),args.signature,failpoint=args.failpoint)
        else: out=state(Path(args.db),args.scope)
        print(json.dumps(out,sort_keys=True))
    except SinkError as exc:
        print(json.dumps({"state":"REFUSED","reason":str(exc)},sort_keys=True),file=sys.stderr); sys.exit(2)

if __name__=="__main__": main()
