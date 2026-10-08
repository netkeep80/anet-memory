#!/usr/bin/env python3
"""Principal/capability separation research over the accepted fenced sink (#63).

This module intentionally exposes *negative* raw-admin helpers.  They model what
happens if an execution agent is given database-admin capabilities in addition
to its generation-scoped writer capability.  No external effect is performed.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve()
COMMIT_BOUNDARY = HERE.parents[1]
sys.path.insert(0, str(COMMIT_BOUNDARY / "fenced-effect-sink"))

from fenced_effect_sink import (  # type: ignore  # noqa: E402
    SinkError,
    apply,
    apply_claim,
    connect,
    init,
    ledger,
    rotate,
    rotation_claim,
    sign_apply,
    sign_rotation,
    state,
)

SCHEMA = "anet-principal-separation/research-1"


def init_authority(db, scope, control_secret, old_writer, old_secret, new_writer, new_secret):
    return init(db, scope, control_secret, old_writer, old_secret, new_writer, new_secret)


def rotate_legitimately(db, scope, control_secret, old_writer, new_writer, request_id="rotate-legit"):
    claim = rotation_claim(scope, 1, old_writer, 2, new_writer, request_id)
    return rotate(db, claim, sign_rotation(control_secret, claim))


def apply_as(db, scope, generation, writer_id, writer_secret, request_id, effect_key, payload=b"x"):
    claim = apply_claim(scope, generation, writer_id, request_id, effect_key, payload)
    return apply(db, claim, sign_apply(writer_secret, claim))


def raw_admin_read_writer_secret(db, writer_id):
    """NEGATIVE CONTROL: direct table read that a writer-only principal must not have."""
    with connect(db) as con:
        row = con.execute("SELECT secret FROM writer_keys WHERE writer_id=?", (writer_id,)).fetchone()
        if not row:
            raise SinkError("UNKNOWN_WRITER")
        return row["secret"]


def raw_admin_rewind_authority(db, scope, generation, writer_id):
    """NEGATIVE CONTROL: bypass the rotation API and rewrite authority directly."""
    with connect(db) as con:
        con.execute("BEGIN IMMEDIATE")
        try:
            exists = con.execute("SELECT 1 FROM writer_keys WHERE writer_id=?", (writer_id,)).fetchone()
            if not exists:
                raise SinkError("UNKNOWN_WRITER")
            cur = con.execute(
                "UPDATE authority SET generation=?, writer_id=?, rotation_request_id=NULL WHERE scope=?",
                (generation, writer_id, scope),
            )
            if cur.rowcount != 1:
                raise SinkError("NO_AUTHORITY")
            con.commit()
        except Exception:
            if con.in_transaction:
                con.rollback()
            raise
    return state(db, scope)


def raw_admin_insert_untracked_effect(db, scope, effect_key, generation, writer_id, request_id, payload_sha256):
    """NEGATIVE CONTROL: direct DML can forge an effect index without API checks."""
    with connect(db) as con:
        con.execute("BEGIN IMMEDIATE")
        try:
            con.execute(
                """INSERT INTO effects(
                     scope,effect_key,generation,writer_id,request_id,payload_sha256,receipt_seq,receipt_hash
                   ) VALUES(?,?,?,?,?,?,?,?)""",
                (scope, effect_key, generation, writer_id, request_id, payload_sha256, -1, "f" * 64),
            )
            con.commit()
        except Exception:
            if con.in_transaction:
                con.rollback()
            raise
    return state(db, scope)


def classify_execution_principal(capabilities):
    """Fail-closed capability classification for an old execution principal."""
    caps = frozenset(capabilities)
    dangerous = {
        "new_writer_secret",
        "raw_db_read",
        "raw_db_write",
    }
    if caps & dangerous:
        return {
            "state": "UNSAFE_EXECUTION_PRINCIPAL",
            "reasons": sorted(caps & dangerous),
            "external_effects_allowed": False,
        }
    if "control_secret" in caps:
        return {
            "state": "CONTROL_PLANE_COLOCATED_WITH_EXECUTOR",
            "reasons": ["control_secret"],
            "external_effects_allowed": False,
        }
    return {
        "state": "GENERATION_SCOPED_WRITER_ONLY",
        "reasons": [],
        "external_effects_allowed": False,
    }


def observed_ledger(db, scope):
    return ledger(db, scope)
