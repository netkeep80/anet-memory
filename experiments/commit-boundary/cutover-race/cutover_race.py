#!/usr/bin/env python3
"""Research-only local cutover race model. Never executes external effects.

All writer/fence decisions are serialized by ONE SQLite authority database.
This is an explicit *assumption* being tested, not a GitHub/Library guarantee.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import signal
import sqlite3
from pathlib import Path

ZERO = '0' * 64
PROTO = 'anet-cutover-race/research-1'


class CutoverError(ValueError):
    pass


def reject(reason):
    raise CutoverError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


@contextmanager
def connect(path):
    con = sqlite3.connect(str(path), timeout=30, isolation_level=None)
    try:
        con.execute('PRAGMA busy_timeout=30000')
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('PRAGMA synchronous=FULL')
        yield con
        if con.in_transaction:
            con.commit()
    except BaseException:
        if con.in_transaction:
            con.rollback()
        raise
    finally:
        con.close()


def schema(con):
    con.execute('''CREATE TABLE IF NOT EXISTS cut_authority (
        id INTEGER PRIMARY KEY CHECK (id=1), phase TEXT NOT NULL,
        generation INTEGER NOT NULL, checkpoint_seq INTEGER,
        checkpoint_head TEXT, checkpoint_digest TEXT,
        terminal_seq INTEGER, terminal_head TEXT)''')
    con.execute('''CREATE TABLE IF NOT EXISTS cut_events (
        sequence INTEGER PRIMARY KEY, generation INTEGER NOT NULL,
        effect_key TEXT NOT NULL UNIQUE, payload_sha256 TEXT NOT NULL,
        prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL)''')


def metadata(con):
    row = con.execute('SELECT phase,generation,checkpoint_seq,checkpoint_head,checkpoint_digest,terminal_seq,terminal_head FROM cut_authority WHERE id=1').fetchone()
    if row is None:
        reject('NOT_INITIALIZED')
    return dict(zip(('phase','generation','checkpoint_seq','checkpoint_head','checkpoint_digest','terminal_seq','terminal_head'), row))


def rows(con):
    return [dict(zip(('sequence','generation','effect_key','payload_sha256','prev_hash','entry_hash'), r))
            for r in con.execute('SELECT sequence,generation,effect_key,payload_sha256,prev_hash,entry_hash FROM cut_events ORDER BY sequence')]


def verify_chain(events):
    previous = ZERO
    for i, row in enumerate(events, 1):
        if row['sequence'] != i or row['prev_hash'] != previous:
            reject('JOURNAL_GAP_OR_FORK')
        if sha(canonical({k: v for k, v in row.items() if k != 'entry_hash'})) != row['entry_hash']:
            reject('JOURNAL_HASH_MISMATCH')
        previous = row['entry_hash']
    return len(events), previous


def init(db):
    with connect(db) as con:
        con.execute('BEGIN IMMEDIATE')
        schema(con)
        if con.execute('SELECT 1 FROM cut_authority WHERE id=1').fetchone():
            reject('ALREADY_INITIALIZED')
        con.execute("INSERT INTO cut_authority VALUES (1,'ACTIVE',1,NULL,NULL,NULL,NULL,NULL)")
        con.execute('COMMIT')
    return {'state': 'ACTIVE', 'generation': 1}


def record(db, generation, key, payload):
    with connect(db) as con:
        con.execute('BEGIN IMMEDIATE')
        m = metadata(con)
        if m['generation'] != generation or m['phase'] not in ('ACTIVE', 'SUCCESSOR_PROMOTED') or (m['phase'] == 'ACTIVE' and generation != 1) or (m['phase'] == 'SUCCESSOR_PROMOTED' and generation != 2):
            reject('WRITER_FENCED')
        previous = con.execute('SELECT sequence,entry_hash FROM cut_events ORDER BY sequence DESC LIMIT 1').fetchone()
        seq = previous[0] + 1 if previous else 1
        prev = previous[1] if previous else ZERO
        row = {'sequence': seq, 'generation': generation, 'effect_key': key,
               'payload_sha256': sha(payload.encode()), 'prev_hash': prev}
        row['entry_hash'] = sha(canonical(row))
        try:
            con.execute('INSERT INTO cut_events VALUES (?,?,?,?,?,?)', tuple(row.values()))
        except sqlite3.IntegrityError:
            reject('DUPLICATE_EFFECT_KEY')
        con.execute('COMMIT')
    return {'state': 'RECORDED', 'sequence': seq, 'entry_hash': row['entry_hash'], 'external_effects_allowed': False}


def checkpoint(db):
    with connect(db) as con:
        con.execute('BEGIN IMMEDIATE')
        m = metadata(con)
        if m['phase'] != 'ACTIVE' or m['checkpoint_seq'] is not None:
            reject('CHECKPOINT_NOT_ALLOWED')
        event_rows = rows(con)
        seq, head = verify_chain(event_rows)
        checksum = sha(canonical(event_rows))
        con.execute('UPDATE cut_authority SET checkpoint_seq=?,checkpoint_head=?,checkpoint_digest=? WHERE id=1', (seq,head,checksum))
        con.execute('COMMIT')
    return {'state': 'CHECKPOINT_SELECTED', 'sequence': seq, 'head': head, 'digest': checksum}


def bootstrap(db, follower):
    # The source prefix is append-only in this one-DB simulator; later writes may
    # extend it, but never mutate the selected prefix through this API.
    with connect(db) as source:
        m = metadata(source)
        if m['checkpoint_seq'] is None:
            reject('CHECKPOINT_REQUIRED')
        prefix = rows(source)[:m['checkpoint_seq']]
        n, head = verify_chain(prefix)
        if n != m['checkpoint_seq'] or head != m['checkpoint_head'] or sha(canonical(prefix)) != m['checkpoint_digest']:
            reject('CHECKPOINT_DRIFT')
    with connect(follower) as dst:
        dst.execute('BEGIN IMMEDIATE')
        schema(dst)
        if dst.execute('SELECT 1 FROM cut_authority WHERE id=1').fetchone():
            reject('FOLLOWER_ALREADY_INITIALIZED')
        dst.execute('INSERT INTO cut_authority VALUES (?,?,?,?,?,?,?,?)',
                    (1,'CHECKPOINT_SELECTED',1,m['checkpoint_seq'],m['checkpoint_head'],m['checkpoint_digest'],None,None))
        for row in prefix:
            dst.execute('INSERT INTO cut_events VALUES (?,?,?,?,?,?)',tuple(row.values()))
        dst.execute('COMMIT')
    return {'state': 'CHECKPOINT_RESTORED', 'sequence': n}


def fence(db, failpoint=None):
    with connect(db) as con:
        con.execute('BEGIN IMMEDIATE')
        m = metadata(con)
        if m['phase'] != 'ACTIVE' or m['checkpoint_seq'] is None:
            reject('FENCE_NOT_ALLOWED')
        event_rows = rows(con)
        n, head = verify_chain(event_rows)
        if (n < m['checkpoint_seq'] or
                sha(canonical(event_rows[:m['checkpoint_seq']])) != m['checkpoint_digest'] or
                verify_chain(event_rows[:m['checkpoint_seq']])[1] != m['checkpoint_head']):
            reject('CHECKPOINT_DRIFT')
        # The fence and terminal commitment are ONE transaction. No unsealed
        # interval exists in which an old writer could escape the terminal head.
        con.execute("UPDATE cut_authority SET phase='CUT_COMMITTED',terminal_seq=?,terminal_head=? WHERE id=1", (n,head))
        if failpoint == 'before-commit':
            os.kill(os.getpid(), signal.SIGKILL)
        con.execute('COMMIT')
        if failpoint == 'after-commit-before-ack':
            os.kill(os.getpid(), signal.SIGKILL)
    return {'state': 'JOURNAL_HEAD_COMMITTED', 'old_generation_fenced': True,
            'terminal_sequence': n, 'terminal_head': head, 'external_effects_allowed': False}


def catchup(db, follower):
    with connect(db) as source:
        m = metadata(source)
        if m['phase'] not in ('CUT_COMMITTED','SUCCESSOR_PROMOTED'):
            reject('CUT_NOT_COMMITTED')
        history = rows(source)
        terminal = history[:m['terminal_seq']]
        n, head = verify_chain(terminal)
        if n != m['terminal_seq'] or head != m['terminal_head']:
            reject('TERMINAL_MISMATCH')
        prefix = terminal[:m['checkpoint_seq']]
        if sha(canonical(prefix)) != m['checkpoint_digest'] or verify_chain(prefix)[1] != m['checkpoint_head']:
            reject('CHECKPOINT_DRIFT')
        # The terminal selector is read from the same serialized authority DB,
        # NOT from a caller-provided manifest or incomplete Library listing.
        tail = terminal[m['checkpoint_seq']:]
    with connect(follower) as dst:
        dst.execute('BEGIN IMMEDIATE')
        fm = metadata(dst)
        current = rows(dst)
        if fm['checkpoint_seq'] != m['checkpoint_seq'] or fm['checkpoint_head'] != m['checkpoint_head'] or fm['checkpoint_digest'] != m['checkpoint_digest']:
            reject('FOLLOWER_ANCHOR_MISMATCH')
        if fm['phase'] == 'CATCHUP_COMPLETE':
            if (fm['terminal_seq'],fm['terminal_head']) != (n,head) or current != terminal:
                reject('FOLLOWER_DIVERGED')
            dst.execute('ROLLBACK')
            return {'state': 'ALREADY_CAUGHT_UP', 'sequence': n}
        if fm['phase'] != 'CHECKPOINT_SELECTED' or current != prefix:
            reject('FOLLOWER_STALE_OR_DIVERGED')
        for row in tail:
            dst.execute('INSERT INTO cut_events VALUES (?,?,?,?,?,?)',tuple(row.values()))
        dst.execute("UPDATE cut_authority SET phase='CATCHUP_COMPLETE',terminal_seq=?,terminal_head=? WHERE id=1", (n,head))
        dst.execute('COMMIT')
    return {'state': 'CATCHUP_COMPLETE', 'sequence': n, 'head': head, 'external_effects_allowed': False}


def promote(db, follower):
    # Both files are local trusted fixtures, NOT distributed transactions.
    # The follower is passive and not independently writable in this harness.
    with connect(db) as source:
        source.execute('BEGIN IMMEDIATE')
        m = metadata(source)
        if m['phase'] != 'CUT_COMMITTED':
            reject('PROMOTION_NOT_ALLOWED')
        with connect(follower) as dst:
            fm = metadata(dst)
            if fm['phase'] != 'CATCHUP_COMPLETE' or (fm['terminal_seq'],fm['terminal_head']) != (m['terminal_seq'],m['terminal_head']):
                reject('CATCHUP_REQUIRED')
            old = rows(dst)
            if verify_chain(old) != (m['terminal_seq'],m['terminal_head']):
                reject('FOLLOWER_DIVERGED')
            if old != rows(source):
                reject('FOLLOWER_DIVERGED')
        source.execute("UPDATE cut_authority SET phase='SUCCESSOR_PROMOTED',generation=2 WHERE id=1")
        source.execute('COMMIT')
    return {'state': 'SUCCESSOR_PROMOTED', 'generation': 2, 'external_effects_allowed': False}


def state(db):
    with connect(db) as con:
        m = metadata(con)
        n, head = verify_chain(rows(con))
    return {**m,'actual_sequence':n,'actual_head':head,'external_effects_allowed':False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['init','record','checkpoint','bootstrap','fence','catchup','promote','state'])
    parser.add_argument('--db',required=True)
    parser.add_argument('--follower')
    parser.add_argument('--generation',type=int,default=1)
    parser.add_argument('--key',default='synthetic')
    parser.add_argument('--payload',default='synthetic')
    parser.add_argument('--failpoint',choices=['before-commit','after-commit-before-ack'])
    a=parser.parse_args()
    try:
        fn={'init': lambda:init(a.db),'record':lambda:record(a.db,a.generation,a.key,a.payload),
            'checkpoint':lambda:checkpoint(a.db),'bootstrap':lambda:bootstrap(a.db,a.follower),
            'fence':lambda:fence(a.db,a.failpoint),'catchup':lambda:catchup(a.db,a.follower),
            'promote':lambda:promote(a.db,a.follower),'state':lambda:state(a.db)}[a.command]
        print(json.dumps(fn(),sort_keys=True))
    except (CutoverError, sqlite3.IntegrityError) as exc:
        print(json.dumps({'state':'FAIL_CLOSED','reason':str(exc)}))
        raise SystemExit(2)


if __name__=='__main__':
    main()
