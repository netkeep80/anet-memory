#!/usr/bin/env python3
"""Research-only: verify hash-anchored journal cut and atomically import SQLite receipts.

The journal head is CALLER-SUPPLIED, not an authenticated GitHub authority.
Importing receipts is NOT executing an external effect. No effect authorization API.
"""
import argparse
import hashlib
import json
import os
import re
import signal
import sqlite3
from pathlib import Path

PROTOCOL = "anet-checkpoint-journal/research-1"
ZERO_HASH = "0" * 64
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$")


class CutoverError(ValueError):
    pass


def fail(code):
    raise CutoverError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def check_hash(value, name):
    if not isinstance(value, str) or not HEX64.fullmatch(value):
        fail("INVALID_" + name)


def check_commit(value):
    if not isinstance(value, str) or not HEX40.fullmatch(value):
        fail("INVALID_COMMIT_SHA")


def check_label(value, name):
    if not isinstance(value, str) or not LABEL.fullmatch(value):
        fail("INVALID_" + name)


def effect_rows(conn, scope):
    return conn.execute(
        "SELECT effect_key,generation,commit_sha,digest FROM effects WHERE scope=? ORDER BY effect_key",
        (scope,),
    ).fetchall()


def current_state(conn, scope):
    a = conn.execute("SELECT generation,commit_sha FROM authority WHERE scope=?", (scope,)).fetchone()
    counter = conn.execute("SELECT value FROM counters WHERE scope=?", (scope,)).fetchone()
    rows = effect_rows(conn, scope)
    if a is None or counter is None or counter[0] != len(rows):
        fail("BASE_STATE_INCONSISTENT")
    return {
        "generation": a[0], "commit_sha": a[1], "count": len(rows),
        "effects_sha256": digest(canonical(rows)),
    }


def make_entry(scope, generation, commit_sha, sequence, prev_hash, key, payload_bytes):
    check_label(scope, "SCOPE")
    check_label(key, "KEY")
    check_commit(commit_sha)
    check_hash(prev_hash, "PREV_HASH")
    if type(generation) is not int or generation < 1 or type(sequence) is not int or sequence < 1:
        fail("INVALID_GENERATION_OR_SEQUENCE")
    if not isinstance(payload_bytes, bytes):
        fail("PAYLOAD_BYTES_REQUIRED")
    row = {
        "scope": scope, "generation": generation, "commit_sha": commit_sha,
        "sequence": sequence, "prev_hash": prev_hash, "effect_key": key,
        "payload_sha256": digest(payload_bytes),
    }
    return {**row, "entry_hash": digest(canonical(row))}


def build_batch(db, scope, events, base_sequence=0, base_head_hash=ZERO_HASH):
    """Build evidence from a SQLite checkpoint and synthetic post-cut records."""
    if type(base_sequence) is not int or base_sequence < 0:
        fail("INVALID_BASE_SEQUENCE")
    check_hash(base_head_hash, "BASE_HEAD")
    with sqlite3.connect(db) as conn:
        state = current_state(conn, scope)
    entries = []
    head = base_head_hash
    for i, (key, payload_bytes) in enumerate(events, start=base_sequence + 1):
        entry = make_entry(scope, state["generation"], state["commit_sha"], i, head, key, payload_bytes)
        entries.append(entry)
        head = entry["entry_hash"]
    return {
        "protocol": PROTOCOL, "scope": scope,
        "generation": state["generation"], "commit_sha": state["commit_sha"],
        "base_sequence": base_sequence, "base_head_hash": base_head_hash,
        "base_count": state["count"], "base_effects_sha256": state["effects_sha256"],
        "target_sequence": base_sequence + len(entries), "target_head_hash": head,
        "entries_sha256": digest(canonical(entries)), "entries": entries,
        "authority_authenticated": False, "external_effects_allowed": False,
    }


def verify_batch(batch):
    if not isinstance(batch, dict) or batch.get("protocol") != PROTOCOL:
        fail("INVALID_PROTOCOL")
    if batch.get("authority_authenticated") is not False or batch.get("external_effects_allowed") is not False:
        fail("UNSAFE_AUTHORITY_CLAIM")
    check_label(batch.get("scope"), "SCOPE")
    check_commit(batch.get("commit_sha"))
    for name in ["base_head_hash", "base_effects_sha256", "target_head_hash", "entries_sha256"]:
        check_hash(batch.get(name), name.upper())
    for name in ["generation", "base_sequence", "target_sequence", "base_count"]:
        v = batch.get(name)
        if type(v) is not int or v < (1 if name == "generation" else 0):
            fail("INVALID_" + name.upper())
    entries = batch.get("entries")
    if not isinstance(entries, list) or len(entries) > 10000:
        fail("INVALID_ENTRIES")
    if batch["target_sequence"] != batch["base_sequence"] + len(entries):
        fail("TARGET_SEQUENCE_MISMATCH")
    if digest(canonical(entries)) != batch["entries_sha256"]:
        fail("ENTRIES_DIGEST_MISMATCH")
    prev = batch["base_head_hash"]
    keys = set()
    for index, entry in enumerate(entries, start=batch["base_sequence"] + 1):
        if not isinstance(entry, dict):
            fail("INVALID_ENTRY")
        required = {
            "scope", "generation", "commit_sha", "sequence",
            "prev_hash", "effect_key", "payload_sha256", "entry_hash",
        }
        if set(entry) != required:
            fail("ENTRY_SHAPE_MISMATCH")
        if entry["scope"] != batch["scope"] or entry["generation"] != batch["generation"] or entry["commit_sha"] != batch["commit_sha"]:
            fail("ENTRY_AUTHORITY_MISMATCH")
        check_label(entry["effect_key"], "KEY")
        for h in ["prev_hash", "payload_sha256", "entry_hash"]:
            check_hash(entry[h], h.upper())
        if type(entry["sequence"]) is not int or entry["sequence"] != index:
            fail("JOURNAL_GAP_OR_FORK")
        if entry["prev_hash"] != prev:
            fail("JOURNAL_PREV_MISMATCH")
        if entry["effect_key"] in keys:
            fail("DUPLICATE_EFFECT_KEY")
        keys.add(entry["effect_key"])
        unhashed = {k: entry[k] for k in required if k != "entry_hash"}
        if digest(canonical(unhashed)) != entry["entry_hash"]:
            fail("ENTRY_HASH_MISMATCH")
        prev = entry["entry_hash"]
    if prev != batch["target_head_hash"]:
        fail("TARGET_HEAD_MISMATCH")
    return {
        "state": "JOURNAL_VERIFIED_UNAUTHENTICATED", "entries": len(entries),
        "target_sequence": batch["target_sequence"], "target_head_hash": prev,
        "external_effects_allowed": False,
    }


def replay(db, batch, failpoint=None):
    """Atomic import of receipts into one local SQLite database; never run effects."""
    verify_batch(batch)
    conn = sqlite3.connect(db, timeout=20, isolation_level=None)
    try:
        conn.execute("PRAGMA busy_timeout=20000")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("""CREATE TABLE IF NOT EXISTS research_cutover_state (
            scope TEXT PRIMARY KEY, target_sequence INTEGER NOT NULL,
            target_head_hash TEXT NOT NULL, final_effects_sha256 TEXT NOT NULL,
            final_count INTEGER NOT NULL)""")
        scope = batch["scope"]
        state = current_state(conn, scope)
        if state["generation"] != batch["generation"] or state["commit_sha"] != batch["commit_sha"]:
            fail("STALE_OR_WRONG_AUTHORITY")
        prior = conn.execute(
            "SELECT target_sequence,target_head_hash,final_effects_sha256,final_count "
            "FROM research_cutover_state WHERE scope=?", (scope,)
        ).fetchone()
        if prior:
            if prior[0] != batch["target_sequence"] or prior[1] != batch["target_head_hash"]:
                fail("COMPETING_CUTOVER")
            if prior[2] != state["effects_sha256"] or prior[3] != state["count"]:
                fail("REPLAY_DB_DIVERGED")
            for entry in batch["entries"]:
                old = conn.execute(
                    "SELECT generation,commit_sha,digest FROM effects WHERE scope=? AND effect_key=?",
                    (scope, entry["effect_key"]),
                ).fetchone()
                if old != (entry["generation"], entry["commit_sha"], entry["payload_sha256"]):
                    fail("REPLAY_RECEIPT_MISMATCH")
            conn.execute("ROLLBACK")
            return {"state": "ALREADY_REPLAYED", "count": state["count"], "external_effects_allowed": False}
        if state["count"] != batch["base_count"] or state["effects_sha256"] != batch["base_effects_sha256"]:
            fail("STALE_OR_DIVERGED_CHECKPOINT")
        for entry in batch["entries"]:
            old = conn.execute(
                "SELECT digest FROM effects WHERE scope=? AND effect_key=?",
                (scope, entry["effect_key"]),
            ).fetchone()
            if old:
                fail("IDEMPOTENCY_KEY_CONFLICT")
            conn.execute(
                "INSERT INTO effects(scope,effect_key,generation,commit_sha,digest) VALUES (?,?,?,?,?)",
                (scope, entry["effect_key"], entry["generation"], entry["commit_sha"], entry["payload_sha256"]),
            )
            conn.execute("UPDATE counters SET value=value+1 WHERE scope=?", (scope,))
        final = current_state(conn, scope)
        conn.execute(
            "INSERT INTO research_cutover_state VALUES (?,?,?,?,?)",
            (scope, batch["target_sequence"], batch["target_head_hash"], final["effects_sha256"], final["count"]),
        )
        if failpoint == "before-commit":
            os.kill(os.getpid(), signal.SIGKILL)
        conn.execute("COMMIT")
        if failpoint == "after-commit-before-ack":
            os.kill(os.getpid(), signal.SIGKILL)
        return {
            "state": "RECEIPTS_IMPORTED", "count": final["count"],
            "target_sequence": batch["target_sequence"],
            "authority": "UNAUTHENTICATED", "external_effects_allowed": False,
        }
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["verify", "replay"])
    parser.add_argument("--batch", required=True)
    parser.add_argument("--db")
    parser.add_argument("--failpoint", choices=["before-commit", "after-commit-before-ack"])
    args = parser.parse_args()
    batch = json.loads(Path(args.batch).read_text(encoding="utf-8"))
    try:
        output = verify_batch(batch) if args.command == "verify" else replay(args.db, batch, args.failpoint)
        print(json.dumps(output, sort_keys=True))
    except CutoverError as err:
        print(json.dumps({"state": "FAIL_CLOSED", "reason": str(err)}))
        raise SystemExit(2)
