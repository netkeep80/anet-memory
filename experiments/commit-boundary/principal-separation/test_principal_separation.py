#!/usr/bin/env python3
import hashlib
import tempfile
import unittest
from pathlib import Path

from principal_separation import (
    SinkError,
    apply_as,
    classify_execution_principal,
    init_authority,
    observed_ledger,
    raw_admin_insert_untracked_effect,
    raw_admin_read_writer_secret,
    raw_admin_rewind_authority,
    rotate_legitimately,
)

SCOPE = "scope-a"
CONTROL = "11" * 32
OLD_SECRET = "22" * 32
NEW_SECRET = "33" * 32
OLD = "writer-old"
NEW = "writer-new"


class PrincipalSeparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="anet-principal-separation-")
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / "sink.sqlite"
        init_authority(self.db, SCOPE, CONTROL, OLD, OLD_SECRET, NEW, NEW_SECRET)

    def test_generation_scoped_old_writer_is_contained_after_rotation(self):
        rotate_legitimately(self.db, SCOPE, CONTROL, OLD, NEW)
        with self.assertRaisesRegex(SinkError, "STALE_AUTHORITY"):
            apply_as(self.db, SCOPE, 1, OLD, OLD_SECRET, "old-r1", "effect-old")

    def test_capability_classifier_accepts_only_writer_scoped_shape(self):
        verdict = classify_execution_principal({"old_writer_secret"})
        self.assertEqual(verdict["state"], "GENERATION_SCOPED_WRITER_ONLY")
        self.assertFalse(verdict["external_effects_allowed"])

    def test_control_credential_must_not_be_colocated_with_executor(self):
        verdict = classify_execution_principal({"old_writer_secret", "control_secret"})
        self.assertEqual(verdict["state"], "CONTROL_PLANE_COLOCATED_WITH_EXECUTOR")
        self.assertIn("control_secret", verdict["reasons"])

    def test_successor_secret_visible_to_old_executor_is_unsafe(self):
        verdict = classify_execution_principal({"old_writer_secret", "new_writer_secret"})
        self.assertEqual(verdict["state"], "UNSAFE_EXECUTION_PRINCIPAL")
        self.assertIn("new_writer_secret", verdict["reasons"])

    def test_raw_database_read_capability_is_unsafe(self):
        verdict = classify_execution_principal({"old_writer_secret", "raw_db_read"})
        self.assertEqual(verdict["state"], "UNSAFE_EXECUTION_PRINCIPAL")
        self.assertIn("raw_db_read", verdict["reasons"])

    def test_raw_database_write_capability_is_unsafe(self):
        verdict = classify_execution_principal({"old_writer_secret", "raw_db_write"})
        self.assertEqual(verdict["state"], "UNSAFE_EXECUTION_PRINCIPAL")
        self.assertIn("raw_db_write", verdict["reasons"])

    def test_raw_admin_read_steals_successor_secret_and_impersonates_successor(self):
        rotate_legitimately(self.db, SCOPE, CONTROL, OLD, NEW)
        leaked = raw_admin_read_writer_secret(self.db, NEW)
        self.assertEqual(leaked, NEW_SECRET)
        result = apply_as(self.db, SCOPE, 2, NEW, leaked, "stolen-r1", "effect-stolen")
        self.assertEqual(result["state"], "APPLIED")

    def test_raw_admin_write_rewinds_authority_and_old_writer_applies_after_rotation(self):
        rotate_legitimately(self.db, SCOPE, CONTROL, OLD, NEW)
        raw_admin_rewind_authority(self.db, SCOPE, 1, OLD)
        result = apply_as(self.db, SCOPE, 1, OLD, OLD_SECRET, "rewound-r1", "effect-rewound")
        self.assertEqual(result["state"], "APPLIED")
        rows = observed_ledger(self.db, SCOPE)
        self.assertEqual([r["kind"] for r in rows], ["AUTHORITY_ROTATED", "EFFECT_APPLIED"])
        self.assertEqual(rows[-1]["generation"], 1)

    def test_direct_admin_dml_can_forge_untracked_effect_index(self):
        rotate_legitimately(self.db, SCOPE, CONTROL, OLD, NEW)
        digest = hashlib.sha256(b"forged").hexdigest()
        st = raw_admin_insert_untracked_effect(
            self.db, SCOPE, "forged-direct", 1, OLD, "raw-admin", digest
        )
        self.assertEqual(st["effect_count"], 1)
        rows = observed_ledger(self.db, SCOPE)
        self.assertEqual([r["kind"] for r in rows], ["AUTHORITY_ROTATED"])
        self.assertNotIn("EFFECT_APPLIED", [r["kind"] for r in rows])

    def test_shared_control_plus_preprovisioned_attacker_writer_enables_takeover(self):
        db = Path(self.tmp.name) / "takeover.sqlite"
        attacker = "writer-attacker"
        attacker_secret = "44" * 32
        init_authority(db, SCOPE, CONTROL, OLD, OLD_SECRET, attacker, attacker_secret)
        rotate_legitimately(db, SCOPE, CONTROL, OLD, attacker, request_id="attacker-rotate")
        result = apply_as(db, SCOPE, 2, attacker, attacker_secret, "attacker-r1", "takeover-effect")
        self.assertEqual(result["state"], "APPLIED")


if __name__ == "__main__":
    unittest.main()
