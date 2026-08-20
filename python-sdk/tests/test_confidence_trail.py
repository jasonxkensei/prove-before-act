"""Unit tests for XProofClient.get_confidence_trail() with mocked HTTP responses."""

import pytest
import responses
from xproof import NotFoundError, XProofClient
from xproof.models import ConfidenceTrail, ConfidenceTrailStage, PolicyViolation

BASE = "https://provebeforeact.com"


def _trail_url(decision_id: str) -> str:
    from urllib.parse import quote

    return f"{BASE}/api/confidence-trail/{quote(decision_id, safe='')}"


@responses.activate
def test_get_confidence_trail_single_stage():
    """Happy path: single-stage trail deserializes into ConfidenceTrail correctly."""
    decision_id = "decision-single-001"
    responses.add(
        responses.GET,
        _trail_url(decision_id),
        json={
            "decision_id": decision_id,
            "total_anchors": 1,
            "current_confidence": 0.6,
            "current_stage": "initial",
            "is_finalized": False,
            "policy_compliant": True,
            "policy_violations": [],
            "stages": [
                {
                    "proof_id": "proof-001",
                    "confidence_level": 0.6,
                    "threshold_stage": "initial",
                    "reversibility_class": "reversible",
                    "anchored_at": "2026-04-20T08:00:00Z",
                    "transaction_hash": "tx-001",
                    "transaction_url": "https://explorer.multiversx.com/tx/001",
                    "policy_violations": [],
                }
            ],
        },
        status=200,
    )
    client = XProofClient()
    trail = client.get_confidence_trail(decision_id)

    assert isinstance(trail, ConfidenceTrail)
    assert trail.decision_id == decision_id
    assert trail.total_anchors == 1
    assert trail.current_confidence == 0.6
    assert trail.current_stage == "initial"
    assert trail.is_finalized is False
    assert trail.policy_compliant is True
    assert trail.policy_violations == []

    assert len(trail.stages) == 1
    stage = trail.stages[0]
    assert isinstance(stage, ConfidenceTrailStage)
    assert stage.proof_id == "proof-001"
    assert stage.confidence_level == 0.6
    assert stage.threshold_stage == "initial"
    assert stage.reversibility_class == "reversible"
    assert stage.anchored_at == "2026-04-20T08:00:00Z"
    assert stage.transaction_hash == "tx-001"
    assert stage.transaction_url == "https://explorer.multiversx.com/tx/001"
    assert stage.policy_violations == []


@responses.activate
def test_get_confidence_trail_multi_stage():
    """Happy path: multi-stage trail deserializes all stages in order."""
    decision_id = "decision-multi-002"
    responses.add(
        responses.GET,
        _trail_url(decision_id),
        json={
            "decision_id": decision_id,
            "total_anchors": 3,
            "current_confidence": 1.0,
            "current_stage": "final",
            "is_finalized": True,
            "policy_compliant": True,
            "policy_violations": [],
            "stages": [
                {
                    "proof_id": "proof-a",
                    "confidence_level": 0.6,
                    "threshold_stage": "initial",
                    "reversibility_class": "reversible",
                    "anchored_at": "2026-04-20T08:00:00Z",
                    "transaction_hash": "tx-a",
                    "transaction_url": "https://explorer.multiversx.com/tx/a",
                    "policy_violations": [],
                },
                {
                    "proof_id": "proof-b",
                    "confidence_level": 0.8,
                    "threshold_stage": "partial",
                    "reversibility_class": "costly",
                    "anchored_at": "2026-04-20T09:00:00Z",
                    "transaction_hash": "tx-b",
                    "transaction_url": "https://explorer.multiversx.com/tx/b",
                    "policy_violations": [],
                },
                {
                    "proof_id": "proof-c",
                    "confidence_level": 1.0,
                    "threshold_stage": "final",
                    "reversibility_class": "irreversible",
                    "anchored_at": "2026-04-20T10:00:00Z",
                    "transaction_hash": "tx-c",
                    "transaction_url": "https://explorer.multiversx.com/tx/c",
                    "policy_violations": [],
                },
            ],
        },
        status=200,
    )
    client = XProofClient()
    trail = client.get_confidence_trail(decision_id)

    assert isinstance(trail, ConfidenceTrail)
    assert trail.decision_id == decision_id
    assert trail.total_anchors == 3
    assert trail.current_confidence == 1.0
    assert trail.current_stage == "final"
    assert trail.is_finalized is True
    assert trail.policy_compliant is True

    assert len(trail.stages) == 3

    first = trail.stages[0]
    assert first.proof_id == "proof-a"
    assert first.confidence_level == 0.6
    assert first.threshold_stage == "initial"
    assert first.reversibility_class == "reversible"

    second = trail.stages[1]
    assert second.proof_id == "proof-b"
    assert second.confidence_level == 0.8
    assert second.threshold_stage == "partial"
    assert second.reversibility_class == "costly"

    third = trail.stages[2]
    assert third.proof_id == "proof-c"
    assert third.confidence_level == 1.0
    assert third.threshold_stage == "final"
    assert third.reversibility_class == "irreversible"


@responses.activate
def test_get_confidence_trail_404_raises_not_found_error():
    """A 404 response raises NotFoundError when no proofs exist for the decision_id."""
    decision_id = "nonexistent-decision"
    responses.add(
        responses.GET,
        _trail_url(decision_id),
        json={"message": "No confidence trail found for the given decision_id"},
        status=404,
    )
    client = XProofClient()
    with pytest.raises(NotFoundError):
        client.get_confidence_trail(decision_id)


@responses.activate
def test_get_confidence_trail_with_policy_violations():
    """Trail with policy violations deserializes violations on both trail and stages."""
    decision_id = "decision-violation-003"
    responses.add(
        responses.GET,
        _trail_url(decision_id),
        json={
            "decision_id": decision_id,
            "total_anchors": 1,
            "current_confidence": 0.5,
            "current_stage": "partial",
            "is_finalized": False,
            "policy_compliant": False,
            "policy_violations": [
                {
                    "proof_id": "proof-v",
                    "confidence_level": 0.5,
                    "reversibility_class": "irreversible",
                    "threshold_stage": "partial",
                    "threshold": 0.95,
                    "rule": "irreversible actions require confidence_level >= 0.95",
                }
            ],
            "stages": [
                {
                    "proof_id": "proof-v",
                    "confidence_level": 0.5,
                    "threshold_stage": "partial",
                    "reversibility_class": "irreversible",
                    "anchored_at": "2026-04-20T08:00:00Z",
                    "transaction_hash": "tx-v",
                    "transaction_url": "",
                    "policy_violations": [
                        {
                            "proof_id": "proof-v",
                            "confidence_level": 0.5,
                            "reversibility_class": "irreversible",
                            "threshold_stage": "partial",
                            "threshold": 0.95,
                            "rule": "irreversible actions require confidence_level >= 0.95",
                        }
                    ],
                }
            ],
        },
        status=200,
    )
    client = XProofClient()
    trail = client.get_confidence_trail(decision_id)

    assert trail.policy_compliant is False
    assert len(trail.policy_violations) == 1

    v = trail.policy_violations[0]
    assert isinstance(v, PolicyViolation)
    assert v.proof_id == "proof-v"
    assert v.confidence_level == 0.5
    assert v.reversibility_class == "irreversible"
    assert v.threshold_stage == "partial"
    assert v.threshold == 0.95
    assert v.rule == "irreversible actions require confidence_level >= 0.95"

    stage = trail.stages[0]
    assert len(stage.policy_violations) == 1
    sv = stage.policy_violations[0]
    assert isinstance(sv, PolicyViolation)
    assert sv.proof_id == "proof-v"
    assert sv.rule == "irreversible actions require confidence_level >= 0.95"


@responses.activate
def test_get_confidence_trail_is_public_endpoint():
    """get_confidence_trail() does not require an API key (Authorization header is empty)."""
    decision_id = "public-trail-test"
    responses.add(
        responses.GET,
        _trail_url(decision_id),
        json={
            "decision_id": decision_id,
            "total_anchors": 0,
            "current_confidence": 0.0,
            "current_stage": "",
            "is_finalized": False,
            "policy_compliant": True,
            "policy_violations": [],
            "stages": [],
        },
        status=200,
    )
    client = XProofClient()
    client.get_confidence_trail(decision_id)

    req = responses.calls[0].request
    assert req.headers.get("Authorization", "") == ""


@responses.activate
def test_get_confidence_trail_raw_preserved():
    """The raw API response dict is accessible via trail.raw."""
    decision_id = "raw-trail-001"
    api_response = {
        "decision_id": decision_id,
        "total_anchors": 1,
        "current_confidence": 0.9,
        "current_stage": "pre-commitment",
        "is_finalized": False,
        "policy_compliant": True,
        "policy_violations": [],
        "stages": [
            {
                "proof_id": "proof-raw",
                "confidence_level": 0.9,
                "threshold_stage": "pre-commitment",
                "anchored_at": "2026-04-20T11:00:00Z",
                "transaction_hash": "tx-raw",
                "transaction_url": "",
                "policy_violations": [],
            }
        ],
        "extra_field": "should be preserved",
    }
    responses.add(
        responses.GET,
        _trail_url(decision_id),
        json=api_response,
        status=200,
    )
    client = XProofClient()
    trail = client.get_confidence_trail(decision_id)

    assert trail.raw == api_response
    assert trail.raw.get("extra_field") == "should be preserved"


@responses.activate
def test_get_confidence_trail_stage_fallback_from_metadata():
    """Stage fields fall back to metadata dict when top-level keys are absent."""
    decision_id = "decision-meta-fallback"
    responses.add(
        responses.GET,
        _trail_url(decision_id),
        json={
            "decision_id": decision_id,
            "total_anchors": 1,
            "current_confidence": 0.7,
            "current_stage": "partial",
            "is_finalized": False,
            "policy_compliant": True,
            "policy_violations": [],
            "stages": [
                {
                    "id": "proof-meta",
                    "metadata": {
                        "confidence_level": 0.7,
                        "threshold_stage": "partial",
                        "reversibility_class": "costly",
                    },
                    "created_at": "2026-04-20T07:00:00Z",
                    "transaction_hash": "tx-meta",
                    "transaction_url": "",
                    "policy_violations": [],
                }
            ],
        },
        status=200,
    )
    client = XProofClient()
    trail = client.get_confidence_trail(decision_id)

    stage = trail.stages[0]
    assert stage.proof_id == "proof-meta"
    assert stage.confidence_level == 0.7
    assert stage.threshold_stage == "partial"
    assert stage.reversibility_class == "costly"
    assert stage.anchored_at == "2026-04-20T07:00:00Z"


@responses.activate
def test_get_confidence_trail_url_encodes_decision_id():
    """The decision_id is URL-encoded in the request path."""
    decision_id = "decision/with spaces&special=chars"
    responses.add(
        responses.GET,
        _trail_url(decision_id),
        json={
            "decision_id": decision_id,
            "total_anchors": 0,
            "current_confidence": 0.0,
            "current_stage": "",
            "is_finalized": False,
            "policy_compliant": True,
            "policy_violations": [],
            "stages": [],
        },
        status=200,
    )
    client = XProofClient()
    trail = client.get_confidence_trail(decision_id)

    assert trail.decision_id == decision_id
    request_url = responses.calls[0].request.url
    assert "decision%2Fwith%20spaces%26special%3Dchars" in request_url
