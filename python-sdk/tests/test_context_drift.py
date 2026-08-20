"""Unit tests for XProofClient.get_context_drift() with mocked HTTP responses."""

import pytest
import responses
from xproof import ContextDrift, ContextDriftStage, NotFoundError, XProofClient

BASE = "https://provebeforeact.com"


def _drift_url(decision_id: str) -> str:
    from urllib.parse import quote

    return f"{BASE}/api/context-drift/{quote(decision_id, safe='')}"


@responses.activate
def test_get_context_drift_coherent():
    """Happy path: fully coherent context returns expected field values."""
    decision_id = "decision-coherent-001"
    responses.add(
        responses.GET,
        _drift_url(decision_id),
        json={
            "context_coherent": True,
            "drift_score": 0.0,
            "fields_drifted": [],
            "fields_stable": ["model_hash", "tools_version", "strategy_snapshot", "operator_scope"],
            "fields_absent": [],
            "stages": [
                {
                    "proof_id": "proof-001",
                    "context_break": False,
                    "drifted_fields": [],
                },
                {
                    "proof_id": "proof-002",
                    "context_break": False,
                    "drifted_fields": [],
                },
            ],
        },
        status=200,
    )
    client = XProofClient()
    result = client.get_context_drift(decision_id)

    assert isinstance(result, ContextDrift)
    assert result.context_coherent is True
    assert result.drift_score == 0.0
    assert result.fields_drifted == []
    assert "model_hash" in result.fields_stable
    assert "tools_version" in result.fields_stable
    assert "strategy_snapshot" in result.fields_stable
    assert "operator_scope" in result.fields_stable
    assert result.fields_absent == []

    assert len(result.stages) == 2
    stage = result.stages[0]
    assert isinstance(stage, ContextDriftStage)
    assert stage.proof_id == "proof-001"
    assert stage.context_break is False
    assert stage.drifted_fields == []


@responses.activate
def test_get_context_drift_with_drift():
    """Happy path: drift detected — context_coherent is False and drift fields populated."""
    decision_id = "decision-drift-002"
    responses.add(
        responses.GET,
        _drift_url(decision_id),
        json={
            "context_coherent": False,
            "drift_score": 0.5,
            "fields_drifted": ["model_hash", "tools_version"],
            "fields_stable": ["operator_scope"],
            "fields_absent": ["strategy_snapshot"],
            "stages": [
                {
                    "proof_id": "proof-a",
                    "context_break": False,
                    "drifted_fields": [],
                },
                {
                    "proof_id": "proof-b",
                    "context_break": True,
                    "drifted_fields": ["model_hash", "tools_version"],
                },
            ],
        },
        status=200,
    )
    client = XProofClient()
    result = client.get_context_drift(decision_id)

    assert isinstance(result, ContextDrift)
    assert result.context_coherent is False
    assert result.drift_score == 0.5
    assert "model_hash" in result.fields_drifted
    assert "tools_version" in result.fields_drifted
    assert result.fields_stable == ["operator_scope"]
    assert result.fields_absent == ["strategy_snapshot"]

    assert len(result.stages) == 2
    first = result.stages[0]
    assert first.proof_id == "proof-a"
    assert first.context_break is False
    assert first.drifted_fields == []

    second = result.stages[1]
    assert second.proof_id == "proof-b"
    assert second.context_break is True
    assert "model_hash" in second.drifted_fields
    assert "tools_version" in second.drifted_fields


@responses.activate
def test_get_context_drift_total_drift():
    """Edge case: drift_score of 1.0 means all tracked fields changed."""
    decision_id = "decision-total-drift-003"
    all_fields = ["model_hash", "tools_version", "strategy_snapshot", "operator_scope"]
    responses.add(
        responses.GET,
        _drift_url(decision_id),
        json={
            "context_coherent": False,
            "drift_score": 1.0,
            "fields_drifted": all_fields,
            "fields_stable": [],
            "fields_absent": [],
            "stages": [
                {
                    "proof_id": "proof-x",
                    "context_break": False,
                    "drifted_fields": [],
                },
                {
                    "proof_id": "proof-y",
                    "context_break": True,
                    "drifted_fields": all_fields,
                },
            ],
        },
        status=200,
    )
    client = XProofClient()
    result = client.get_context_drift(decision_id)

    assert isinstance(result, ContextDrift)
    assert result.context_coherent is False
    assert result.drift_score == 1.0
    assert set(result.fields_drifted) == set(all_fields)
    assert result.fields_stable == []


@responses.activate
def test_get_context_drift_404_raises_not_found_error():
    """A 404 response raises NotFoundError when no decision chain exists."""
    decision_id = "nonexistent-decision"
    responses.add(
        responses.GET,
        _drift_url(decision_id),
        json={"message": "No context drift data found for the given decision_id"},
        status=404,
    )
    client = XProofClient()
    with pytest.raises(NotFoundError):
        client.get_context_drift(decision_id)


@responses.activate
def test_get_context_drift_is_public_endpoint():
    """get_context_drift() suppresses the Authorization header even when an API key is set."""
    decision_id = "public-drift-test"
    responses.add(
        responses.GET,
        _drift_url(decision_id),
        json={
            "context_coherent": True,
            "drift_score": 0.0,
            "fields_drifted": [],
            "fields_stable": [],
            "fields_absent": [],
            "stages": [],
        },
        status=200,
    )
    client = XProofClient(api_key="pm_test_key")
    client.get_context_drift(decision_id)

    req = responses.calls[0].request
    assert req.headers.get("Authorization", "") == ""


@responses.activate
def test_get_context_drift_url_encodes_decision_id():
    """The decision_id is URL-encoded in the request path."""
    decision_id = "decision/with spaces&special=chars"
    responses.add(
        responses.GET,
        _drift_url(decision_id),
        json={
            "context_coherent": True,
            "drift_score": 0.0,
            "fields_drifted": [],
            "fields_stable": [],
            "fields_absent": [],
            "stages": [],
        },
        status=200,
    )
    client = XProofClient()
    client.get_context_drift(decision_id)

    request_url = responses.calls[0].request.url
    assert "decision%2Fwith%20spaces%26special%3Dchars" in request_url


@responses.activate
def test_get_context_drift_raw_preserved():
    """get_context_drift() preserves the full raw API response in result.raw."""
    decision_id = "raw-dict-test"
    api_response = {
        "context_coherent": True,
        "drift_score": 0.0,
        "fields_drifted": [],
        "fields_stable": ["model_hash"],
        "fields_absent": ["strategy_snapshot"],
        "stages": [],
        "extra_field": "preserved",
    }
    responses.add(
        responses.GET,
        _drift_url(decision_id),
        json=api_response,
        status=200,
    )
    client = XProofClient()
    result = client.get_context_drift(decision_id)

    assert isinstance(result, ContextDrift)
    assert result.raw == api_response
    assert result.raw.get("extra_field") == "preserved"
    assert result.fields_stable == ["model_hash"]
    assert result.fields_absent == ["strategy_snapshot"]
