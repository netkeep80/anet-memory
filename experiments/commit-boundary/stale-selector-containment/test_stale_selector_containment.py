#!/usr/bin/env python3
import tempfile
import unittest
from pathlib import Path

from stale_selector_containment import (
    ContainmentError,
    SinkError,
    UngatedExternalEffectMock,
    advance_sink_to_generation2,
    classify_sink,
    clone_sink,
    consumer_from_selector,
    discovery_observation,
    gated_effect,
    init_two_generation_sink,
    reversible_read,
)
from selector_contract import make_selector, selector_bytes, sha256_bytes

SCOPE = "anet-memory/commit-boundary/main"
CONTROL = "11" * 32
OLD_SECRET = "22" * 32
NEW_SECRET = "33" * 32
OLD = "writer-old"
NEW = "writer-new"
C1 = "1" * 40
C2 = "2" * 40
H64 = "a" * 64


def selector(generation: int, previous: str | None):
    return make_selector(
        scope=SCOPE,
        generation=generation,
        previous_selector_sha256=previous,
        source_terminal_seq=generation,
        source_terminal_head=H64,
        sink_freeze_seq=generation,
        sink_freeze_hash="b" * 64,
        sink_terminal_effect_seq=generation,
        sink_terminal_effect_head="c" * 64,
        reconcile_digest="d" * 64,
        evidence_commit_sha=C1 if generation == 1 else C2,
    )


class StaleSelectorContainmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="anet-stale-selector-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root / "sink.sqlite"
        init_two_generation_sink(self.db, SCOPE, CONTROL, OLD, OLD_SECRET, NEW, NEW_SECRET)
        self.s1 = selector(1, None)
        self.s1raw = selector_bytes(self.s1)
        self.s2 = selector(2, sha256_bytes(self.s1raw))
        self.old = consumer_from_selector(self.s1, OLD, OLD_SECRET, selector_authenticity_assumed=True)
        self.new = consumer_from_selector(self.s2, NEW, NEW_SECRET, selector_authenticity_assumed=True)

    def test_stale_verified_selector_may_drive_read_only_computation(self):
        advance_sink_to_generation2(self.db, SCOPE, CONTROL, OLD, NEW)
        result = reversible_read(self.old, {"value": "old-state"})
        self.assertEqual(result["generation"], 1)
        self.assertFalse(result["effect_eligible"])

    def test_stale_consumer_effect_is_rejected_by_current_single_sink(self):
        advance_sink_to_generation2(self.db, SCOPE, CONTROL, OLD, NEW)
        with self.assertRaisesRegex(SinkError, "STALE_AUTHORITY"):
            gated_effect(self.db, self.old, "old-r1", "effect-1", b"payload")
        self.assertEqual(classify_sink(self.db, SCOPE)["effect_count"], 0)

    def test_fresh_consumer_effect_succeeds_after_rotation(self):
        advance_sink_to_generation2(self.db, SCOPE, CONTROL, OLD, NEW)
        self.assertEqual(gated_effect(self.db, self.new, "new-r1", "effect-1", b"payload")["state"], "APPLIED")
        self.assertEqual(classify_sink(self.db, SCOPE)["effect_count"], 1)

    def test_stale_selector_does_not_become_current_because_next_lookup_misses(self):
        observation = discovery_observation(next_generation_found=False)
        self.assertEqual(observation["state"], "FRESHNESS_UNKNOWN")
        self.assertFalse(observation["latest_proven"])

    def test_positive_next_lookup_still_does_not_prove_global_latest(self):
        observation = discovery_observation(next_generation_found=True)
        self.assertEqual(observation["state"], "NEWER_SELECTOR_OBSERVED")
        self.assertFalse(observation["latest_proven"])

    def test_unverified_selector_cannot_construct_effect_capable_consumer(self):
        with self.assertRaisesRegex(ContainmentError, "SELECTOR_NOT_AUTHENTICATED"):
            consumer_from_selector(self.s1, OLD, OLD_SECRET, selector_authenticity_assumed=False)

    def test_split_brain_clone_falsifies_containment(self):
        clone = self.root / "clone.sqlite"
        clone_sink(self.db, clone)
        advance_sink_to_generation2(self.db, SCOPE, CONTROL, OLD, NEW)
        self.assertEqual(gated_effect(clone, self.old, "old-r-clone", "split-effect", b"payload")["state"], "APPLIED")
        self.assertEqual(classify_sink(self.db, SCOPE)["effect_count"], 0)
        self.assertEqual(classify_sink(clone, SCOPE)["effect_count"], 1)

    def test_ungated_external_destination_falsifies_containment(self):
        advance_sink_to_generation2(self.db, SCOPE, CONTROL, OLD, NEW)
        external = UngatedExternalEffectMock()
        result = external.apply(effect_key="unsafe", payload=b"payload")
        self.assertEqual(result["state"], "EXTERNAL_EFFECT_EXECUTED_UNGATED")
        self.assertEqual(external.count, 1)

    def test_old_credential_cannot_claim_new_writer_identity(self):
        advance_sink_to_generation2(self.db, SCOPE, CONTROL, OLD, NEW)
        forged = consumer_from_selector(self.s2, NEW, OLD_SECRET, selector_authenticity_assumed=True)
        with self.assertRaisesRegex(SinkError, "AUTH_FAILED"):
            gated_effect(self.db, forged, "forged", "effect-x", b"payload")

    def test_fresh_retry_remains_idempotent(self):
        advance_sink_to_generation2(self.db, SCOPE, CONTROL, OLD, NEW)
        first = gated_effect(self.db, self.new, "same-request", "same-effect", b"payload")
        retry = gated_effect(self.db, self.new, "same-request", "same-effect", b"payload")
        self.assertEqual(first["state"], "APPLIED")
        self.assertEqual(retry["state"], "ALREADY_APPLIED")
        self.assertEqual(classify_sink(self.db, SCOPE)["effect_count"], 1)

    def test_original_sink_rejects_stale_even_if_clone_accepted_it(self):
        clone = self.root / "clone-2.sqlite"
        clone_sink(self.db, clone)
        advance_sink_to_generation2(self.db, SCOPE, CONTROL, OLD, NEW)
        self.assertEqual(gated_effect(clone, self.old, "clone-r", "same-key", b"payload")["state"], "APPLIED")
        with self.assertRaisesRegex(SinkError, "STALE_AUTHORITY"):
            gated_effect(self.db, self.old, "orig-r", "same-key", b"payload")

    def test_model_never_claims_external_effect_permission(self):
        advance_sink_to_generation2(self.db, SCOPE, CONTROL, OLD, NEW)
        self.assertFalse(classify_sink(self.db, SCOPE)["external_effects_allowed"])


if __name__ == "__main__":
    unittest.main()
