#!/usr/bin/env python3
"""Adversarial tests of research-only SQLite receipt journal cutover."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from cutover_journal import (
    CutoverError, ZERO_HASH, build_batch, canonical, digest, replay, verify_batch,
)


def make_db(path):
    c = sqlite3.connect(path)
    c.executescript("""
    CREATE TABLE authority(scope TEXT PRIMARY KEY,generation INTEGER,commit_sha TEXT);
    CREATE TABLE effects(scope TEXT,effect_key TEXT,generation INTEGER,commit_sha TEXT,digest TEXT,
                         PRIMARY KEY(scope,effect_key));
    CREATE TABLE counters(scope TEXT PRIMARY KEY,value INTEGER);
    """)
    c.execute("INSERT INTO authority VALUES (?,?,?)", ("run54", 2, "b" * 40))
    c.execute(
        "INSERT INTO effects VALUES (?,?,?,?,?)",
        ("run54", "initial-key", 2, "b" * 40, hashlib.sha256(b"initial").hexdigest()),
    )
    c.execute("INSERT INTO counters VALUES ('run54',1)")
    c.commit()
    c.close()


def counts(db):
    c = sqlite3.connect(db)
    n = c.execute("SELECT count(*) FROM effects").fetchone()[0]
    v = c.execute("SELECT value FROM counters WHERE scope='run54'").fetchone()[0]
    c.close()
    return (n, v)


def write_json(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")


class CutoverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="anet-journal-cut-")
        self.db = Path(self.tmp.name) / "receipts.sqlite"
        self.batchfile = Path(self.tmp.name) / "cut.json"
        make_db(self.db)
        self.batch = build_batch(self.db, "run54", [("new-a", b"payload-a"), ("new-b", b"payload-b")])

    def tearDown(self):
        self.tmp.cleanup()

    def test_valid_chain_still_untrusted(self):
        v = verify_batch(self.batch)
        self.assertEqual(v["state"], "JOURNAL_VERIFIED_UNAUTHENTICATED")
        self.assertFalse(v["external_effects_allowed"])
        self.assertEqual(self.batch["target_sequence"], 2)
        self.assertEqual(self.batch["base_head_hash"], ZERO_HASH)

    def test_atomic_receipt_import_and_replay_no_duplicate(self):
        r = replay(self.db, self.batch)
        self.assertEqual(r["state"], "RECEIPTS_IMPORTED")
        self.assertEqual(counts(self.db), (3, 3))
        self.assertEqual(replay(self.db, self.batch)["state"], "ALREADY_REPLAYED")
        self.assertEqual(counts(self.db), (3, 3))

    def test_wrong_digest_even_if_list_digest_is_recomputed(self):
        bad = copy.deepcopy(self.batch)
        bad["entries"][0]["payload_sha256"] = "a" * 64
        bad["entries_sha256"] = digest(canonical(bad["entries"]))
        with self.assertRaisesRegex(CutoverError, "ENTRY_HASH_MISMATCH"):
            verify_batch(bad)

    def test_missing_middle_event_cannot_claim_old_head(self):
        bad = copy.deepcopy(self.batch)
        bad["entries"].pop(0)
        bad["target_sequence"] = 1
        bad["entries_sha256"] = digest(canonical(bad["entries"]))
        with self.assertRaisesRegex(CutoverError, "JOURNAL_GAP_OR_FORK"):
            verify_batch(bad)

    def test_reordered_events_are_detected(self):
        bad = copy.deepcopy(self.batch)
        bad["entries"].reverse()
        bad["entries_sha256"] = digest(canonical(bad["entries"]))
        with self.assertRaisesRegex(CutoverError, "JOURNAL_GAP_OR_FORK"):
            verify_batch(bad)

    def test_prev_hash_fork_detected(self):
        bad = copy.deepcopy(self.batch)
        bad["entries"][1]["prev_hash"] = ZERO_HASH
        bad["entries_sha256"] = digest(canonical(bad["entries"]))
        with self.assertRaisesRegex(CutoverError, "JOURNAL_PREV_MISMATCH"):
            verify_batch(bad)

    def test_alternative_committed_head_refused(self):
        bad = copy.deepcopy(self.batch)
        bad["target_head_hash"] = "c" * 64
        with self.assertRaisesRegex(CutoverError, "TARGET_HEAD_MISMATCH"):
            verify_batch(bad)

    def test_same_logical_key_inside_batch_refused(self):
        bad = copy.deepcopy(self.batch)
        bad["entries"][1]["effect_key"] = "new-a"
        bad["entries_sha256"] = digest(canonical(bad["entries"]))
        with self.assertRaisesRegex(CutoverError, "DUPLICATE_EFFECT_KEY"):
            verify_batch(bad)

    def test_existing_idempotency_key_rolls_back_entire_replay(self):
        bad = build_batch(self.db, "run54", [("new-a", b"a"), ("initial-key", b"new")])
        with self.assertRaisesRegex(CutoverError, "IDEMPOTENCY_KEY_CONFLICT"):
            replay(self.db, bad)
        self.assertEqual(counts(self.db), (1, 1))

    def test_uncommitted_post_snapshot_receipt_rejects_stale_checkpoint(self):
        with sqlite3.connect(self.db) as conn:
            conn.execute("INSERT INTO effects VALUES (?,?,?,?,?)",
                         ("run54", "late", 2, "b"*40, digest(b"late")))
            conn.execute("UPDATE counters SET value=2 WHERE scope='run54'")
        with self.assertRaisesRegex(CutoverError, "STALE_OR_DIVERGED_CHECKPOINT"):
            replay(self.db, self.batch)
        self.assertEqual(counts(self.db), (2, 2))

    def test_unauthorized_generation_rejected(self):
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE authority SET generation=3 WHERE scope='run54'")
        with self.assertRaisesRegex(CutoverError, "STALE_OR_WRONG_AUTHORITY"):
            replay(self.db, self.batch)
        self.assertEqual(counts(self.db), (1, 1))

    def test_no_external_authorization_can_be_claimed_in_batch(self):
        bad = copy.deepcopy(self.batch)
        bad["external_effects_allowed"] = True
        with self.assertRaisesRegex(CutoverError, "UNSAFE_AUTHORITY_CLAIM"):
            verify_batch(bad)
        bad = copy.deepcopy(self.batch)
        bad["authority_authenticated"] = True
        with self.assertRaisesRegex(CutoverError, "UNSAFE_AUTHORITY_CLAIM"):
            verify_batch(bad)

    def test_failed_replay_with_unknown_competing_head_does_not_rewrite(self):
        replay(self.db, self.batch)
        alt = copy.deepcopy(self.batch)
        alt["target_head_hash"] = "1"*64
        with self.assertRaises(CutoverError):
            replay(self.db, alt)
        self.assertEqual(counts(self.db), (3, 3))

    def test_real_sigkill_before_commit_rolls_back_entire_journal(self):
        write_json(self.batchfile, self.batch)
        p = subprocess.run([sys.executable, str(Path(__file__).with_name("cutover_journal.py")),
                            "replay", "--db", str(self.db), "--batch", str(self.batchfile),
                            "--failpoint", "before-commit"], capture_output=True)
        self.assertEqual(p.returncode, -9)
        self.assertEqual(counts(self.db), (1, 1))
        self.assertEqual(replay(self.db, self.batch)["state"], "RECEIPTS_IMPORTED")
        self.assertEqual(counts(self.db), (3, 3))

    def test_real_sigkill_after_commit_before_ack_deduplicates(self):
        write_json(self.batchfile, self.batch)
        p = subprocess.run([sys.executable, str(Path(__file__).with_name("cutover_journal.py")),
                            "replay", "--db", str(self.db), "--batch", str(self.batchfile),
                            "--failpoint", "after-commit-before-ack"], capture_output=True)
        self.assertEqual(p.returncode, -9)
        self.assertEqual(counts(self.db), (3, 3))
        self.assertEqual(replay(self.db, self.batch)["state"], "ALREADY_REPLAYED")
        self.assertEqual(counts(self.db), (3, 3))

    def test_two_isolated_clones_import_same_journal_independently(self):
        import shutil
        other = Path(self.tmp.name) / "other.sqlite"
        shutil.copyfile(self.db, other)
        self.assertEqual(replay(self.db, self.batch)["state"], "RECEIPTS_IMPORTED")
        self.assertEqual(replay(other, self.batch)["state"], "RECEIPTS_IMPORTED")
        self.assertEqual(counts(self.db), (3, 3))
        self.assertEqual(counts(other), (3, 3))
        # NOT a global effect-dedup oracle: the copies did not share transactions.


if __name__ == "__main__":
    unittest.main(verbosity=2)
