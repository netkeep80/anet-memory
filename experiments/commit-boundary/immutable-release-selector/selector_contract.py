#!/usr/bin/env python3
"""Pure contract checks for a future GitHub Immutable Release selector test.

This module never calls GitHub and never asserts that a release is actually
immutable.  It only defines the exact selector bytes/tag/chain and validates an
externally supplied platform-verification observation.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

SCHEMA = "anet-immutable-release-selector/research-1"
ASSET_NAME = "selector.json"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class SelectorError(ValueError):
    pass


def canonical(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def scope_hash(scope: str) -> str:
    if not isinstance(scope, str) or not scope or len(scope) > 256:
        raise SelectorError("INVALID_SCOPE")
    return sha256_bytes(scope.encode("utf-8"))


def canonical_tag(scope: str, generation: int) -> str:
    if not isinstance(generation, int) or generation < 1 or generation > 99999999999999999999:
        raise SelectorError("INVALID_GENERATION")
    return f"anet-cutover/v1/{scope_hash(scope)}/g{generation:020d}"


def make_selector(*, scope: str, generation: int, previous_selector_sha256: str | None,
                  source_terminal_seq: int, source_terminal_head: str,
                  sink_freeze_seq: int, sink_freeze_hash: str,
                  sink_terminal_effect_seq: int, sink_terminal_effect_head: str,
                  reconcile_digest: str, evidence_commit_sha: str) -> dict:
    selector = {
        "schema": SCHEMA,
        "scope": scope,
        "scope_sha256": scope_hash(scope),
        "generation": generation,
        "previous_selector_sha256": previous_selector_sha256,
        "source": {"terminal_seq": source_terminal_seq, "terminal_head": source_terminal_head},
        "sink": {
            "freeze_seq": sink_freeze_seq,
            "freeze_hash": sink_freeze_hash,
            "terminal_effect_seq": sink_terminal_effect_seq,
            "terminal_effect_head": sink_terminal_effect_head,
        },
        "reconcile_digest": reconcile_digest,
        "evidence_commit_sha": evidence_commit_sha,
    }
    validate_selector(selector)
    return selector


def validate_selector(selector: dict) -> None:
    if set(selector) != {"schema","scope","scope_sha256","generation","previous_selector_sha256","source","sink","reconcile_digest","evidence_commit_sha"}:
        raise SelectorError("SELECTOR_KEYS_MISMATCH")
    if selector["schema"] != SCHEMA:
        raise SelectorError("SCHEMA_MISMATCH")
    if selector["scope_sha256"] != scope_hash(selector["scope"]):
        raise SelectorError("SCOPE_HASH_MISMATCH")
    canonical_tag(selector["scope"], selector["generation"])
    prev = selector["previous_selector_sha256"]
    if prev is not None and not HEX64.fullmatch(prev):
        raise SelectorError("INVALID_PREDECESSOR_SHA")
    if selector["generation"] == 1 and prev is not None:
        raise SelectorError("ROOT_MUST_NOT_HAVE_PREDECESSOR")
    if selector["generation"] > 1 and prev is None:
        raise SelectorError("PREDECESSOR_REQUIRED")
    source = selector["source"]
    sink = selector["sink"]
    if set(source) != {"terminal_seq","terminal_head"} or set(sink) != {"freeze_seq","freeze_hash","terminal_effect_seq","terminal_effect_head"}:
        raise SelectorError("EVIDENCE_KEYS_MISMATCH")
    for name, value in (("source_terminal_seq", source["terminal_seq"]), ("sink_freeze_seq", sink["freeze_seq"]), ("sink_terminal_effect_seq", sink["terminal_effect_seq"])):
        if not isinstance(value, int) or value < 0:
            raise SelectorError(f"INVALID_{name.upper()}")
    for name, value in (("source_terminal_head", source["terminal_head"]), ("sink_freeze_hash", sink["freeze_hash"]), ("sink_terminal_effect_head", sink["terminal_effect_head"]), ("reconcile_digest", selector["reconcile_digest"])):
        if not isinstance(value, str) or not HEX64.fullmatch(value):
            raise SelectorError(f"INVALID_{name.upper()}")
    if not isinstance(selector["evidence_commit_sha"], str) or not HEX40.fullmatch(selector["evidence_commit_sha"]):
        raise SelectorError("INVALID_EVIDENCE_COMMIT")


def selector_bytes(selector: dict) -> bytes:
    validate_selector(selector)
    return canonical(selector)


def verify_transition(previous_bytes: bytes, current_bytes: bytes) -> dict:
    previous = json.loads(previous_bytes)
    current = json.loads(current_bytes)
    validate_selector(previous); validate_selector(current)
    if previous["scope"] != current["scope"]:
        raise SelectorError("SCOPE_CHANGED")
    if current["generation"] != previous["generation"] + 1:
        raise SelectorError("NON_CONTIGUOUS_GENERATION")
    if current["previous_selector_sha256"] != sha256_bytes(previous_bytes):
        raise SelectorError("PREDECESSOR_MISMATCH")
    return {"state":"CHAIN_OK","generation":current["generation"]}


def verify_platform_observation(selector_raw: bytes, observation: dict) -> dict:
    """Verify evidence gathered by the future *real* GitHub experiment.

    `release_verified` stands for successful `gh release verify TAG` and
    `asset_verified` for successful `gh release verify-asset TAG selector.json`.
    Passing booleans here is not itself proof; the actual experiment must record
    the command/tool evidence separately.
    """
    selector = json.loads(selector_raw)
    validate_selector(selector)
    expected_tag = canonical_tag(selector["scope"], selector["generation"])
    expected_digest = "sha256:" + sha256_bytes(selector_raw)
    required = {"immutable","tag_name","attested_commit_sha","asset_name","asset_digest","release_verified","asset_verified"}
    if set(observation) != required:
        raise SelectorError("OBSERVATION_KEYS_MISMATCH")
    if observation["immutable"] is not True:
        raise SelectorError("RELEASE_NOT_IMMUTABLE")
    if observation["tag_name"] != expected_tag:
        raise SelectorError("TAG_MISMATCH")
    if observation["attested_commit_sha"] != selector["evidence_commit_sha"]:
        raise SelectorError("ATTESTED_COMMIT_MISMATCH")
    if observation["asset_name"] != ASSET_NAME:
        raise SelectorError("ASSET_NAME_MISMATCH")
    if observation["asset_digest"] != expected_digest:
        raise SelectorError("ASSET_DIGEST_MISMATCH")
    if observation["release_verified"] is not True:
        raise SelectorError("RELEASE_ATTESTATION_NOT_VERIFIED")
    if observation["asset_verified"] is not True:
        raise SelectorError("ASSET_NOT_VERIFIED")
    return {"state":"PLATFORM_OBSERVATION_CONTRACT_OK","tag":expected_tag,"selector_sha256":sha256_bytes(selector_raw),"external_effects_allowed":False}
