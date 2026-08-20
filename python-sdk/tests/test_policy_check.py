"""Unit tests for XProofClient.get_policy_check() with mocked HTTP responses."""

import pytest
import responses
from xproof import NotFoundError, XProofClient
from xproof.models import PolicyCheckResult, PolicyViolation

BASE = "https://provebeforeact.com"
POLICY_CHECK_URL = f"{BASE}/api/proofs/policy-check"


@responses.activate
def test_get_policy_check_compliant():
    """Happy path: compliant decision chain returns PolicyCheckResult with no violations."""
    decision_id = "decision-abc-001"
    responses.add(
        responses.GET,
        POLICY_CHECK_URL,
        json={
            "decision_id": decision_id,
            "policy_compliant": True,
            "policy_violations": [],
            "total_anchors": 3,
            "checked_at": "2026-04-20T10:00:00Z",
        },
        status=200,
    )
    client = XProofClient()
    result = client.get_policy_check(decision_id)

    assert isinstance(result, PolicyCheckResult)
    assert result.decision_id == decision_id
    assert result.policy_compliant is True
    assert result.policy_violations == []
    assert result.total_anchors == 3
    assert result.checked_at == "2026-04-20T10:00:00Z"
    assert result.raw["decision_id"] == decision_id


@responses.activate
def test_get_policy_check_non_compliant():
    """Happy path: non-compliant decision chain returns violations deserialized as PolicyViolation objects."""
    decision_id = "decision-xyz-002"
    responses.add(
        responses.GET,
        POLICY_CHECK_URL,
        json={
            "decision_id": decision_id,
            "policy_compliant": False,
            "policy_violations": [
                {
                    "proof_id": "proof-xyz-1",
                    "confidence_level": 0.7,
                    "reversibility_class": "irreversible",
                    "threshold_stage": "partial",
                    "threshold": 0.95,
                    "rule": "irreversible actions require confidence_level >= 0.95",
                },
                {
                    "proof_id": "proof-xyz-2",
                    "confidence_level": None,
                    "reversibility_class": "irreversible",
                    "threshold_stage": None,
                    "threshold": 0.95,
                    "rule": "irreversible actions require confidence_level >= 0.95",
                },
            ],
            "total_anchors": 2,
            "checked_at": "2026-04-20T11:30:00Z",
        },
        status=200,
    )
    client = XProofClient()
    result = client.get_policy_check(decision_id)

    assert isinstance(result, PolicyCheckResult)
    assert result.decision_id == decision_id
    assert result.policy_compliant is False
    assert result.total_anchors == 2
    assert result.checked_at == "2026-04-20T11:30:00Z"

    assert len(result.policy_violations) == 2

    first = result.policy_violations[0]
    assert isinstance(first, PolicyViolation)
    assert first.proof_id == "proof-xyz-1"
    assert first.confidence_level == 0.7
    assert first.reversibility_class == "irreversible"
    assert first.threshold_stage == "partial"
    assert first.threshold == 0.95
    assert first.rule == "irreversible actions require confidence_level >= 0.95"

    second = result.policy_violations[1]
    assert isinstance(second, PolicyViolation)
    assert second.proof_id == "proof-xyz-2"
    assert second.confidence_level is None
    assert second.threshold_stage is None
    assert second.rule == "irreversible actions require confidence_level >= 0.95"


@responses.activate
def test_get_policy_check_404_raises_not_found_error():
    """A 404 response raises NotFoundError when no proofs exist for the decision_id."""
    responses.add(
        responses.GET,
        POLICY_CHECK_URL,
        json={"message": "No proofs found for the given decision_id"},
        status=404,
    )
    client = XProofClient()
    with pytest.raises(NotFoundError):
        client.get_policy_check("nonexistent-decision-id")


@responses.activate
def test_get_policy_check_sends_decision_id_as_query_param():
    """The decision_id is passed as a query parameter, not in the URL path."""
    decision_id = "decision-param-check"
    responses.add(
        responses.GET,
        POLICY_CHECK_URL,
        json={
            "decision_id": decision_id,
            "policy_compliant": True,
            "policy_violations": [],
            "total_anchors": 1,
            "checked_at": "2026-04-20T09:00:00Z",
        },
        status=200,
    )
    client = XProofClient()
    client.get_policy_check(decision_id)

    assert len(responses.calls) == 1
    request_url = responses.calls[0].request.url
    assert "decision_id=decision-param-check" in request_url
    assert "/api/proofs/policy-check" in request_url


@responses.activate
def test_get_policy_check_is_public_endpoint():
    """get_policy_check() does not require an API key (Authorization header is empty)."""
    responses.add(
        responses.GET,
        POLICY_CHECK_URL,
        json={
            "decision_id": "public-test",
            "policy_compliant": True,
            "policy_violations": [],
            "total_anchors": 0,
            "checked_at": "",
        },
        status=200,
    )
    client = XProofClient()
    client.get_policy_check("public-test")

    req = responses.calls[0].request
    assert req.headers.get("Authorization", "") == ""


@responses.activate
def test_get_policy_check_raw_preserved():
    """The raw API response dict is accessible via result.raw."""
    api_response = {
        "decision_id": "raw-check-001",
        "policy_compliant": True,
        "policy_violations": [],
        "total_anchors": 5,
        "checked_at": "2026-04-20T12:00:00Z",
        "extra_field": "should be preserved",
    }
    responses.add(
        responses.GET,
        POLICY_CHECK_URL,
        json=api_response,
        status=200,
    )
    client = XProofClient()
    result = client.get_policy_check("raw-check-001")

    assert result.raw == api_response
    assert result.raw.get("extra_field") == "should be preserved"


def test_get_policy_check_empty_decision_id_raises_value_error():
    """An empty or blank decision_id raises ValueError locally before any HTTP call."""
    client = XProofClient()
    with pytest.raises(ValueError, match="decision_id is required"):
        client.get_policy_check("")


def test_get_policy_check_blank_decision_id_raises_value_error():
    """A whitespace-only decision_id also raises ValueError locally."""
    client = XProofClient()
    with pytest.raises(ValueError, match="decision_id is required"):
        client.get_policy_check("   ")
