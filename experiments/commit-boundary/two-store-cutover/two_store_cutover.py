#!/usr/bin/env python3
"""Research-only two-store cutover protocol.

Two independent SQLite databases model a durable source outbox and a downstream
synthetic effect sink. There is intentionally no transaction spanning both DBs.
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
SCHEMA = "anet-two-store-cutover/research-1"


class ProtocolError(RuntimeError):
    pass


def canonical(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def mac(secret: str, obj: dict[str, Any]) -> str:
    return hmac.new(bytes.fromhex(secret), canonical(obj), hashlib.sha256).hexdigest()


@contextmanager
def db(path: Path | str):
    con = sqlite3.connect(str(path), timeout=20, isolation_level=None)
    try:
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=FULL")
        yield con
    finally:
        con.close()


def _source_schema(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS source_meta(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      phase TEXT NOT NULL,
      generation INTEGER NOT NULL,
      attest_secret TEXT NOT NULL,
      terminal_seq INTEGER,
      terminal_head TEXT,
      reconcile_digest TEXT,
      reconcile_json TEXT,
      activation_digest TEXT,
      activation_seq INTEGER,
      activation_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS intents(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      effect_key TEXT NOT NULL UNIQUE,
      payload_sha256 TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE
    );
    """)


def _sink_schema(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS sink_meta(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      scope TEXT NOT NULL,
      phase TEXT NOT NULL,
      generation INTEGER NOT NULL,
      writer_id TEXT NOT NULL,
      old_writer TEXT NOT NULL,
      old_secret TEXT NOT NULL,
      new_writer TEXT NOT NULL,
      new_secret TEXT NOT NULL,
      control_secret TEXT NOT NULL,
      source_attest_secret TEXT NOT NULL,
      freeze_request_id TEXT,
      freeze_seq INTEGER,
      freeze_hash TEXT,
      terminal_effect_seq INTEGER,
      terminal_effect_head TEXT,
      activation_request_id TEXT,
      activation_digest TEXT,
      activation_seq INTEGER,
      activation_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS sink_ledger(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      generation INTEGER NOT NULL,
      writer_id TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      effect_key TEXT,
      payload_sha256 TEXT,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE,
      reconcile_digest TEXT
    );
    CREATE TABLE IF NOT EXISTS sink_effects(
      effect_key TEXT PRIMARY KEY,
      payload_sha256 TEXT NOT NULL,
      generation INTEGER NOT NULL,
      writer_id TEXT NOT NULL,
      receipt_seq INTEGER NOT NULL,
      receipt_hash TEXT NOT NULL
    );
    """)


def _head(con, table: str) -> str:
    row = con.execute(f"SELECT entry_hash FROM {table} ORDER BY seq DESC LIMIT 1").fetchone()
    return row[0] if row else ZERO


def init_source(path: Path | str, attest_secret: str):
    with db(path) as con:
        _source_schema(con)
        if con.execute("SELECT 1 FROM source_meta").fetchone(): raise ProtocolError("SOURCE_ALREADY_INITIALIZED")
        con.execute("INSERT INTO source_meta VALUES(1,'ACTIVE',1,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",(attest_secret,))
    return source_state(path)


def init_sink(path: Path | str, scope: str, old_writer: str, old_secret: str, new_writer: str, new_secret: str, control_secret: str, source_attest_secret: str):
    with db(path) as con:
        _sink_schema(con)
        if con.execute("SELECT 1 FROM sink_meta").fetchone(): raise ProtocolError("SINK_ALREADY_INITIALIZED")
        con.execute("INSERT INTO sink_meta VALUES(1,?,'ACTIVE',1,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
                    (scope,old_writer,old_writer,old_secret,new_writer,new_secret,control_secret,source_attest_secret))
    return sink_state(path)


def enqueue(source: Path|str, effect_key: str, payload: bytes):
    with db(source) as con:
        _source_schema(con); con.execute("BEGIN IMMEDIATE")
        try:
            m=con.execute("SELECT phase FROM source_meta WHERE singleton=1").fetchone()
            if m[0] != 'ACTIVE': raise ProtocolError("SOURCE_FENCED")
            pd=sha(payload); prev=_head(con,'intents')
            body={"effect_key":effect_key,"payload_sha256":pd,"prev_hash":prev}
            eh=sha(canonical(body))
            cur=con.execute("INSERT INTO intents(effect_key,payload_sha256,prev_hash,entry_hash) VALUES(?,?,?,?)",(effect_key,pd,prev,eh))
            con.commit(); return {"state":"INTENT_DURABLE","seq":cur.lastrowid,"entry_hash":eh,"payload_sha256":pd}
        except Exception:
            if con.in_transaction: con.rollback()
            raise


def fence_source(source: Path|str, *, failpoint: str|None=None):
    with db(source) as con:
        _source_schema(con); con.execute("BEGIN IMMEDIATE")
        try:
            m=con.execute("SELECT * FROM source_meta WHERE singleton=1").fetchone()
            if m['phase'] in ('SOURCE_FENCED','RECONCILED','PROMOTED'):
                con.rollback(); return {"state":"SOURCE_ALREADY_FENCED","terminal_seq":m['terminal_seq'],"terminal_head":m['terminal_head']}
            if m['phase']!='ACTIVE': raise ProtocolError("SOURCE_FENCE_INVALID_PHASE")
            row=con.execute("SELECT COALESCE(MAX(seq),0) s FROM intents").fetchone(); ts=int(row['s']); th=_head(con,'intents')
            con.execute("UPDATE source_meta SET phase='SOURCE_FENCED',terminal_seq=?,terminal_head=? WHERE singleton=1",(ts,th))
            if failpoint=='before-commit': os.kill(os.getpid(),signal.SIGKILL)
            con.commit()
            if failpoint=='after-commit-before-ack': os.kill(os.getpid(),signal.SIGKILL)
            return {"state":"SOURCE_FENCED","terminal_seq":ts,"terminal_head":th}
        except Exception:
            if con.in_transaction: con.rollback()
            raise


def writer_claim(scope: str, generation: int, writer_id: str, request_id: str, effect_key: str, payload_sha256: str):
    return {"op":"apply","scope":scope,"generation":generation,"writer_id":writer_id,"request_id":request_id,"effect_key":effect_key,"payload_sha256":payload_sha256}


def freeze_claim(scope: str, request_id: str):
    return {"op":"freeze","scope":scope,"expected_generation":1,"expected_writer_id":"writer-old","request_id":request_id}


def activation_claim(scope: str, request_id: str, reconcile_digest: str, freeze_hash: str):
    return {"op":"activate","scope":scope,"next_generation":2,"next_writer_id":"writer-new","request_id":request_id,"reconcile_digest":reconcile_digest,"freeze_hash":freeze_hash}


def _verify_source_terminal(con: sqlite3.Connection, meta: sqlite3.Row) -> list[dict]:
    rows=[dict(r) for r in con.execute("SELECT * FROM intents ORDER BY seq")]
    prev=ZERO
    for expected,row in enumerate(rows, start=1):
        if row['seq']!=expected or row['prev_hash']!=prev:
            raise ProtocolError("SOURCE_CHAIN_DISCONTINUITY")
        body={"effect_key":row['effect_key'],"payload_sha256":row['payload_sha256'],"prev_hash":prev}
        if sha(canonical(body))!=row['entry_hash']:
            raise ProtocolError("SOURCE_CHAIN_HASH_MISMATCH")
        prev=row['entry_hash']
    if len(rows)!=int(meta['terminal_seq']) or prev!=meta['terminal_head']:
        raise ProtocolError("SOURCE_TERMINAL_DIVERGED")
    return rows


def _verify_frozen_sink(con: sqlite3.Connection, meta: sqlite3.Row) -> list[dict]:
    if meta['phase']!='FROZEN': raise ProtocolError("SINK_NOT_FROZEN")
    rows=[dict(r) for r in con.execute("SELECT * FROM sink_ledger ORDER BY seq")]
    if not rows or rows[-1]['seq']!=meta['freeze_seq'] or rows[-1]['kind']!='SINK_FROZEN' or rows[-1]['entry_hash']!=meta['freeze_hash']:
        raise ProtocolError("SINK_FREEZE_RECEIPT_MISMATCH")
    prev=ZERO; effect_rows=[]
    for expected,row in enumerate(rows, start=1):
        if row['seq']!=expected or row['prev_hash']!=prev:
            raise ProtocolError("SINK_CHAIN_DISCONTINUITY")
        if row['kind']=='EFFECT_APPLIED':
            claim=writer_claim(meta['scope'],int(row['generation']),row['writer_id'],row['request_id'],row['effect_key'],row['payload_sha256'])
            body={**claim,"kind":"EFFECT_APPLIED","prev_hash":prev}
            effect_rows.append(row)
        elif row['kind']=='SINK_FROZEN' and row['seq']==meta['freeze_seq']:
            claim={"op":"freeze","scope":meta['scope'],"expected_generation":1,"expected_writer_id":meta['old_writer'],"request_id":meta['freeze_request_id']}
            body={**claim,"kind":"SINK_FROZEN","terminal_effect_seq":meta['terminal_effect_seq'],"terminal_effect_head":meta['terminal_effect_head'],"prev_hash":prev}
        else:
            raise ProtocolError("SINK_FROZEN_LEDGER_INVALID_KIND")
        if sha(canonical(body))!=row['entry_hash']:
            raise ProtocolError("SINK_CHAIN_HASH_MISMATCH")
        prev=row['entry_hash']
    expected_effect_seq=effect_rows[-1]['seq'] if effect_rows else 0
    expected_effect_head=effect_rows[-1]['entry_hash'] if effect_rows else ZERO
    if expected_effect_seq!=meta['terminal_effect_seq'] or expected_effect_head!=meta['terminal_effect_head']:
        raise ProtocolError("SINK_TERMINAL_EFFECT_DIVERGED")
    index=[dict(r) for r in con.execute("SELECT * FROM sink_effects ORDER BY effect_key")]
    ledger_index={r['effect_key']:(r['payload_sha256'],r['generation'],r['writer_id'],r['seq'],r['entry_hash']) for r in effect_rows}
    effect_index={r['effect_key']:(r['payload_sha256'],r['generation'],r['writer_id'],r['receipt_seq'],r['receipt_hash']) for r in index}
    if effect_index!=ledger_index:
        raise ProtocolError("SINK_RECEIPT_INDEX_MISMATCH")
    return index


def _verify_activation_receipt(con: sqlite3.Connection, meta: sqlite3.Row, activation_digest: str) -> tuple[int,str]:
    if (meta['phase']!='ACTIVE' or meta['generation']!=2 or meta['activation_digest']!=activation_digest or
            meta['activation_seq'] is None or meta['activation_hash'] is None):
        raise ProtocolError("SINK_SUCCESSOR_NOT_ACTIVE")
    ar=con.execute("SELECT * FROM sink_ledger WHERE seq=?",(meta['activation_seq'],)).fetchone()
    if (not ar or ar['kind']!='SUCCESSOR_ACTIVATED' or ar['entry_hash']!=meta['activation_hash'] or
            ar['reconcile_digest']!=activation_digest or ar['prev_hash']!=meta['freeze_hash'] or
            int(ar['seq'])!=int(meta['freeze_seq'])+1):
        raise ProtocolError("ACTIVATION_RECEIPT_MISMATCH")
    claim=activation_claim(meta['scope'],meta['activation_request_id'],activation_digest,meta['freeze_hash'])
    body={**claim,"kind":"SUCCESSOR_ACTIVATED","prev_hash":meta['freeze_hash']}
    if sha(canonical(body))!=meta['activation_hash']:
        raise ProtocolError("ACTIVATION_RECEIPT_MISMATCH")
    return int(meta['activation_seq']),meta['activation_hash']


def sink_apply(sink: Path|str, claim: dict, signature: str):
    with db(sink) as con:
        _sink_schema(con)
        m=con.execute("SELECT * FROM sink_meta WHERE singleton=1").fetchone()
        secret = m['old_secret'] if claim.get('writer_id')==m['old_writer'] else m['new_secret'] if claim.get('writer_id')==m['new_writer'] else None
        if not secret or not hmac.compare_digest(mac(secret,claim),signature): raise ProtocolError("WRITER_AUTH_FAILED")
        con.execute("BEGIN IMMEDIATE")
        try:
            m=con.execute("SELECT * FROM sink_meta WHERE singleton=1").fetchone()
            if m['phase']!='ACTIVE': raise ProtocolError("SINK_FROZEN")
            if claim['scope']!=m['scope'] or claim['generation']!=m['generation'] or claim['writer_id']!=m['writer_id']:
                raise ProtocolError("STALE_AUTHORITY")
            old=con.execute("SELECT * FROM sink_effects WHERE effect_key=?",(claim['effect_key'],)).fetchone()
            if old:
                if old['payload_sha256']==claim['payload_sha256']:
                    con.rollback(); return {"state":"ALREADY_APPLIED","receipt_seq":old['receipt_seq'],"receipt_hash":old['receipt_hash']}
                raise ProtocolError("IDEMPOTENCY_CONFLICT")
            prev=_head(con,'sink_ledger'); body={**claim,"kind":"EFFECT_APPLIED","prev_hash":prev}; eh=sha(canonical(body))
            cur=con.execute("INSERT INTO sink_ledger(kind,generation,writer_id,request_id,effect_key,payload_sha256,prev_hash,entry_hash,reconcile_digest) VALUES('EFFECT_APPLIED',?,?,?,?,?,?,?,NULL)",
                            (claim['generation'],claim['writer_id'],claim['request_id'],claim['effect_key'],claim['payload_sha256'],prev,eh))
            con.execute("INSERT INTO sink_effects VALUES(?,?,?,?,?,?)",(claim['effect_key'],claim['payload_sha256'],claim['generation'],claim['writer_id'],cur.lastrowid,eh))
            con.commit(); return {"state":"APPLIED","receipt_seq":cur.lastrowid,"receipt_hash":eh}
        except Exception:
            if con.in_transaction: con.rollback()
            raise


def freeze_sink(sink: Path|str, claim: dict, signature: str, *, failpoint: str|None=None):
    with db(sink) as con:
        _sink_schema(con); m=con.execute("SELECT * FROM sink_meta WHERE singleton=1").fetchone()
        if not hmac.compare_digest(mac(m['control_secret'],claim),signature): raise ProtocolError("CONTROL_AUTH_FAILED")
        con.execute("BEGIN IMMEDIATE")
        try:
            m=con.execute("SELECT * FROM sink_meta WHERE singleton=1").fetchone()
            if m['phase']=='FROZEN' and m['freeze_request_id']==claim['request_id']:
                con.rollback(); return {"state":"SINK_ALREADY_FROZEN","freeze_seq":m['freeze_seq'],"freeze_hash":m['freeze_hash'],"terminal_effect_seq":m['terminal_effect_seq'],"terminal_effect_head":m['terminal_effect_head']}
            if m['phase']!='ACTIVE' or m['generation']!=1 or m['writer_id']!=m['old_writer']: raise ProtocolError("FREEZE_CAS_MISMATCH")
            effect_row=con.execute("SELECT COALESCE(MAX(seq),0) s FROM sink_ledger WHERE kind='EFFECT_APPLIED'").fetchone(); tes=int(effect_row['s']); teh=_head(con,'sink_ledger')
            prev=teh; body={**claim,"kind":"SINK_FROZEN","terminal_effect_seq":tes,"terminal_effect_head":teh,"prev_hash":prev}; fh=sha(canonical(body))
            cur=con.execute("INSERT INTO sink_ledger(kind,generation,writer_id,request_id,effect_key,payload_sha256,prev_hash,entry_hash,reconcile_digest) VALUES('SINK_FROZEN',1,?,?,NULL,NULL,?,?,NULL)",
                            (m['old_writer'],claim['request_id'],prev,fh))
            con.execute("UPDATE sink_meta SET phase='FROZEN',freeze_request_id=?,freeze_seq=?,freeze_hash=?,terminal_effect_seq=?,terminal_effect_head=? WHERE singleton=1",
                        (claim['request_id'],cur.lastrowid,fh,tes,teh))
            if failpoint=='before-commit': os.kill(os.getpid(),signal.SIGKILL)
            con.commit()
            if failpoint=='after-commit-before-ack': os.kill(os.getpid(),signal.SIGKILL)
            return {"state":"SINK_FROZEN","freeze_seq":cur.lastrowid,"freeze_hash":fh,"terminal_effect_seq":tes,"terminal_effect_head":teh}
        except Exception:
            if con.in_transaction: con.rollback()
            raise


def reconcile(source: Path|str, sink: Path|str):
    # Read exact frozen sink snapshot first; source transaction then binds it.
    with db(sink) as sc:
        _sink_schema(sc); sm=sc.execute("SELECT * FROM sink_meta WHERE singleton=1").fetchone()
        if sm['phase']!='FROZEN': raise ProtocolError("SINK_NOT_FROZEN")
        effects=_verify_frozen_sink(sc,sm)
        freeze={k:sm[k] for k in ('freeze_seq','freeze_hash','terminal_effect_seq','terminal_effect_head')}
    with db(source) as con:
        _source_schema(con); con.execute("BEGIN IMMEDIATE")
        try:
            m=con.execute("SELECT * FROM source_meta WHERE singleton=1").fetchone()
            if m['phase']=='RECONCILED':
                cert=json.loads(m['reconcile_json']); con.rollback(); return {"state":"ALREADY_RECONCILED","certificate":cert,"digest":m['reconcile_digest'],"signature":mac(m['attest_secret'],cert)}
            if m['phase']!='SOURCE_FENCED': raise ProtocolError("SOURCE_NOT_FENCED")
            _verify_source_terminal(con,m)
            intents=[dict(r) for r in con.execute("SELECT * FROM intents ORDER BY effect_key")]
            im={r['effect_key']:r for r in intents}; em={r['effect_key']:r for r in effects}
            extra=sorted(set(em)-set(im))
            if extra: raise ProtocolError("UNTRACKED_SINK_EFFECT")
            applied=[]; pending=[]
            for key,row in im.items():
                er=em.get(key)
                if er:
                    if er['payload_sha256']!=row['payload_sha256']: raise ProtocolError("SINK_PAYLOAD_MISMATCH")
                    applied.append(key)
                else: pending.append(key)
            cert={"schema":SCHEMA,"source_terminal_seq":m['terminal_seq'],"source_terminal_head":m['terminal_head'],
                  **freeze,"applied_keys":sorted(applied),"pending_keys":sorted(pending)}
            dg=sha(canonical(cert)); con.execute("UPDATE source_meta SET phase='RECONCILED',reconcile_digest=?,reconcile_json=? WHERE singleton=1",(dg,canonical(cert).decode()))
            con.commit(); return {"state":"RECONCILED","certificate":cert,"digest":dg,"signature":mac(m['attest_secret'],cert)}
        except Exception:
            if con.in_transaction: con.rollback()
            raise


def activate_sink(sink: Path|str, claim: dict, control_sig: str, certificate: dict, source_sig: str, *, failpoint: str|None=None):
    with db(sink) as con:
        _sink_schema(con); m=con.execute("SELECT * FROM sink_meta WHERE singleton=1").fetchone()
        if not hmac.compare_digest(mac(m['control_secret'],claim),control_sig): raise ProtocolError("CONTROL_AUTH_FAILED")
        if not hmac.compare_digest(mac(m['source_attest_secret'],certificate),source_sig): raise ProtocolError("SOURCE_ATTEST_FAILED")
        dg=sha(canonical(certificate))
        if dg!=claim['reconcile_digest'] or certificate.get('freeze_hash')!=claim['freeze_hash']: raise ProtocolError("CERTIFICATE_BINDING_MISMATCH")
        con.execute("BEGIN IMMEDIATE")
        try:
            m=con.execute("SELECT * FROM sink_meta WHERE singleton=1").fetchone()
            if m['phase']=='ACTIVE' and m['generation']==2 and m['activation_request_id']==claim['request_id']:
                if m['activation_digest']!=dg: raise ProtocolError("ACTIVATION_CONFLICT")
                con.rollback(); return {"state":"SUCCESSOR_ALREADY_ACTIVE","reconcile_digest":dg,"activation_seq":m['activation_seq'],"activation_hash":m['activation_hash']}
            if m['phase']!='FROZEN': raise ProtocolError("SINK_NOT_FROZEN")
            if m['freeze_hash']!=claim['freeze_hash'] or m['freeze_seq']!=certificate.get('freeze_seq') or m['terminal_effect_head']!=certificate.get('terminal_effect_head'):
                raise ProtocolError("STALE_FREEZE_CERTIFICATE")
            prev=_head(con,'sink_ledger'); body={**claim,"kind":"SUCCESSOR_ACTIVATED","prev_hash":prev}; eh=sha(canonical(body))
            con.execute("INSERT INTO sink_ledger(kind,generation,writer_id,request_id,effect_key,payload_sha256,prev_hash,entry_hash,reconcile_digest) VALUES('SUCCESSOR_ACTIVATED',2,?,?,NULL,NULL,?,?,?)",
                        (m['new_writer'],claim['request_id'],prev,eh,dg))
            activation_seq=con.execute("SELECT seq FROM sink_ledger WHERE request_id=?",(claim['request_id'],)).fetchone()[0]
            con.execute("UPDATE sink_meta SET phase='ACTIVE',generation=2,writer_id=new_writer,activation_request_id=?,activation_digest=?,activation_seq=?,activation_hash=? WHERE singleton=1",(claim['request_id'],dg,activation_seq,eh))
            if failpoint=='before-commit': os.kill(os.getpid(),signal.SIGKILL)
            con.commit()
            if failpoint=='after-commit-before-ack': os.kill(os.getpid(),signal.SIGKILL)
            return {"state":"SUCCESSOR_ACTIVE","reconcile_digest":dg,"activation_seq":activation_seq,"activation_hash":eh}
        except Exception:
            if con.in_transaction: con.rollback()
            raise


def mark_promoted(source: Path|str, sink: Path|str, activation_digest: str):
    # SOURCE PROMOTED is only an observation of a durable sink activation.
    # It cannot itself authorize effects, and it must not be writable from the
    # reconciliation digest alone.
    with db(sink) as sc:
        _sink_schema(sc)
        sm=sc.execute("SELECT * FROM sink_meta WHERE singleton=1").fetchone()
        if not sm: raise ProtocolError("SINK_SUCCESSOR_NOT_ACTIVE")
        activation_seq,activation_hash=_verify_activation_receipt(sc,sm,activation_digest)
    with db(source) as con:
        _source_schema(con); con.execute("BEGIN IMMEDIATE")
        try:
            m=con.execute("SELECT * FROM source_meta WHERE singleton=1").fetchone()
            if m['phase']=='PROMOTED':
                if m['activation_digest']!=activation_digest or m['activation_seq']!=activation_seq or m['activation_hash']!=activation_hash:
                    raise ProtocolError("PROMOTION_BINDING_MISMATCH")
                con.rollback(); return {"state":"ALREADY_PROMOTED","activation_seq":activation_seq,"activation_hash":activation_hash}
            if m['phase']!='RECONCILED' or m['reconcile_digest']!=activation_digest:
                raise ProtocolError("PROMOTION_BINDING_MISMATCH")
            con.execute("UPDATE source_meta SET phase='PROMOTED',generation=2,activation_digest=?,activation_seq=?,activation_hash=? WHERE singleton=1",
                        (activation_digest,activation_seq,activation_hash)); con.commit()
            return {"state":"PROMOTED","generation":2,"activation_seq":activation_seq,"activation_hash":activation_hash}
        except Exception:
            if con.in_transaction: con.rollback()
            raise


def source_state(path):
    with db(path) as con:
        _source_schema(con); m=con.execute("SELECT * FROM source_meta WHERE singleton=1").fetchone()
        return dict(m) if m else None


def sink_state(path):
    with db(path) as con:
        _sink_schema(con); m=con.execute("SELECT * FROM sink_meta WHERE singleton=1").fetchone()
        return ({k:m[k] for k in m.keys() if 'secret' not in k} | {"effect_count":con.execute("SELECT COUNT(*) FROM sink_effects").fetchone()[0],"external_effects_allowed":False}) if m else None


def get_intents(path):
    with db(path) as con: return [dict(r) for r in con.execute("SELECT * FROM intents ORDER BY seq")]


def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
    for cmd in ('fence-source','freeze-sink','activate-sink'):
        q=sub.add_parser(cmd); q.add_argument('--source'); q.add_argument('--sink'); q.add_argument('--json'); q.add_argument('--sig'); q.add_argument('--cert'); q.add_argument('--source-sig'); q.add_argument('--failpoint')
    a=p.parse_args()
    try:
        if a.cmd=='fence-source': out=fence_source(a.source,failpoint=a.failpoint)
        elif a.cmd=='freeze-sink': out=freeze_sink(a.sink,json.loads(a.json),a.sig,failpoint=a.failpoint)
        else: out=activate_sink(a.sink,json.loads(a.json),a.sig,json.loads(a.cert),a.source_sig,failpoint=a.failpoint)
        print(json.dumps(out,sort_keys=True))
    except ProtocolError as exc:
        print(json.dumps({"state":"REFUSED","reason":str(exc)}),file=sys.stderr); sys.exit(2)

if __name__=='__main__': main()
