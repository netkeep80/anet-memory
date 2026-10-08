#!/usr/bin/env python3
"""Research-only composition: stale selector containment under one fenced sink.

This module composes the already-merged immutable selector contract (#66) and
fenced synthetic effect sink (#63).  It proves no GitHub platform property and
performs no external side effect.
"""
from __future__ import annotations

import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve()
COMMIT_BOUNDARY = HERE.parents[1]
sys.path.insert(0, str(COMMIT_BOUNDARY / "immutable-release-selector"))
sys.path.insert(0, str(COMMIT_BOUNDARY / "fenced-effect-sink"))

from selector_contract import validate_selector  # type: ignore  # noqa: E402
from fenced_effect_sink import (  # type: ignore  # noqa: E402
    SinkError,
    apply,
    apply_claim,
    init,
    rotate,
    rotation_claim,
    sign_apply,
    sign_rotation,
    state,
)

SCHEMA = "anet-stale-selector-containment/research-1"


class ContainmentError(RuntimeError):
    pass


@dataclass(frozen=True)
class ConsumerView:
    scope: str
    generation: int
    writer_id: str
    writer_secret: str
    selector_authenticity_assumed: bool


def consumer_from_selector(selector: dict, writer_id: str, writer_secret: str,
                           *, selector_authenticity_assumed: bool) -> ConsumerView:
    validate_selector(selector)
    if not selector_authenticity_assumed:
        raise ContainmentError("SELECTOR_NOT_AUTHENTICATED")
    return ConsumerView(
        scope=selector["scope"],
        generation=int(selector["generation"]),
        writer_id=writer_id,
        writer_secret=writer_secret,
        selector_authenticity_assumed=True,
    )


def reversible_read(view: ConsumerView, snapshot: dict) -> dict:
    """Stale reads/computation are allowed but explicitly carry generation."""
    return {
        "state": "READ_ONLY_RESULT",
        "generation": view.generation,
        "snapshot": json.loads(json.dumps(snapshot, sort_keys=True)),
        "effect_eligible": False,
    }


def effect_claim(view: ConsumerView, request_id: str, effect_key: str, payload: bytes):
    claim = apply_claim(view.scope, view.generation, view.writer_id, request_id, effect_key, payload)
    return claim, sign_apply(view.writer_secret, claim)


def gated_effect(db: Path | str, view: ConsumerView, request_id: str, effect_key: str, payload: bytes) -> dict:
    """Only the sink decides whether the consumer's generation is current."""
    claim, signature = effect_claim(view, request_id, effect_key, payload)
    return apply(db, claim, signature)


def discovery_observation(*, next_generation_found: bool) -> dict:
    """A miss can never certify that the current local generation is latest."""
    if next_generation_found:
        return {"state": "NEWER_SELECTOR_OBSERVED", "latest_proven": False}
    return {"state": "FRESHNESS_UNKNOWN", "latest_proven": False}


def clone_sink(source: Path | str, target: Path | str) -> None:
    """Negative split-brain fixture: byte-copy an independently writable sink."""
    shutil.copyfile(source, target)


class UngatedExternalEffectMock:
    """Negative control: represents a destination with no authority gate."""
    def __init__(self) -> None:
        self.count = 0
        self.keys: set[str] = set()

    def apply(self, *, effect_key: str, payload: bytes) -> dict:
        # Deliberately ignores selector generation, authority and credentials.
        self.count += 1
        self.keys.add(effect_key)
        return {"state": "EXTERNAL_EFFECT_EXECUTED_UNGATED", "payload_size": len(payload)}


def init_two_generation_sink(db: Path | str, scope: str, control: str,
                             old_writer: str, old_secret: str,
                             new_writer: str, new_secret: str) -> None:
    init(db, scope, control, old_writer, old_secret, new_writer, new_secret)


def advance_sink_to_generation2(db: Path | str, scope: str, control: str,
                                old_writer: str, new_writer: str,
                                request_id: str = "rotation-1") -> dict:
    claim = rotation_claim(scope, 1, old_writer, 2, new_writer, request_id)
    return rotate(db, claim, sign_rotation(control, claim))


def classify_sink(db: Path | str, scope: str) -> dict:
    observed = state(db, scope)
    return {
        "schema": SCHEMA,
        "authority_generation": observed["authority"]["generation"],
        "effect_count": observed["effect_count"],
        "external_effects_allowed": False,
    }
