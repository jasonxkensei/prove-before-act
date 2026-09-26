"""Unit tests for XProofCertifyTool using a mocked XProofClient."""

import hashlib
import json
from unittest.mock import MagicMock

import pytest
import responses

pytest.importorskip("langchain_core", reason="langchain-core not installed")

from xproof.client import XProofClient
from xproof.exceptions import PolicyViolationError
from xproof.langchain_tool import XProofCertifyTool
from xproof.models import Certification, PolicyCheckResult, PolicyViolation

DECISION_ID = "test-decision-001"
TRANSACTION_HASH = "0xdeadbeefcafe1234"
BASE = "https://provebeforeact.com"


def _make_cert(transaction_hash: str = TRANSACTION_HASH) -> Certification:
    return Certification(
        id="proof-001",
        file_name=f"{DECISION_ID}-pre-commitment.json",
        file_hash="a" * 64,
        transaction_hash=transaction_hash,
        transaction_url="https://explorer.multiversx.com/tx/abc",
        created_at="2026-04-20T10:00:00Z",
    )


def _make_compliant_check() -> PolicyCheckResult:
    return PolicyCheckResult(
        decision_id=DECISION_ID,
        total_anchors=1,
        policy_compliant=True,
        policy_violations=[],
        checked_at="2026-04-20T10:00:00Z",
    )


def _make_violation_check(violations: list) -> PolicyCheckResult:
    return PolicyCheckResult(
        decision_id=DECISION_ID,
        total_anchors=1,
        policy_compliant=False,
        policy_violations=violations,
        checked_at="2026-04-20T10:00:00Z",
    )


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.certify_with_confidence.return_value = _make_cert()
    client.get_policy_check.return_value = _make_compliant_check()
    return client


@pytest.fixture
def tool(mock_client):
    return XProofCertifyTool(api_key="pm_test", author="test-agent", client=mock_client)


def test_successful_certification_returns_transaction_hash(tool, mock_client):
    """Happy path: run() returns the transaction_hash when policy check passes."""
    result = tool._run(
        decision_text="Approve GDPR data deletion",
        confidence_level=0.97,
        decision_id=DECISION_ID,
        threshold_stage="pre-commitment",
    )

    assert result == TRANSACTION_HASH
    mock_client.certify_with_confidence.assert_called_once()
    mock_client.get_policy_check.assert_called_once_with(DECISION_ID)


def test_policy_violation_raises_policy_violation_error(tool, mock_client):
    """When policy_compliant is False, PolicyViolationError is raised."""
    violations = [
        PolicyViolation(
            proof_id="proof-001",
            confidence_level=0.5,
            reversibility_class="irreversible",
            threshold_stage="final",
            threshold=0.95,
            rule="irreversible_confidence_threshold",
        )
    ]
    mock_client.get_policy_check.return_value = _make_violation_check(violations)

    with pytest.raises(PolicyViolationError):
        tool._run(
            decision_text="Delete production database",
            confidence_level=0.5,
            decision_id=DECISION_ID,
            threshold_stage="final",
            reversibility_class="irreversible",
        )


def test_policy_violation_error_includes_violations_list(tool, mock_client):
    """PolicyViolationError.violations contains the full list of PolicyViolation objects."""
    violations = [
        PolicyViolation(
            proof_id="proof-002",
            confidence_level=0.4,
            reversibility_class="irreversible",
            threshold_stage="partial",
            threshold=0.95,
            rule="irreversible_confidence_threshold",
        ),
        PolicyViolation(
            proof_id="proof-003",
            confidence_level=None,
            reversibility_class="irreversible",
            threshold_stage=None,
            threshold=0.95,
            rule="missing_reversibility_class",
        ),
    ]
    mock_client.get_policy_check.return_value = _make_violation_check(violations)

    with pytest.raises(PolicyViolationError) as exc_info:
        tool._run(
            decision_text="Some risky action",
            confidence_level=0.4,
            decision_id=DECISION_ID,
            threshold_stage="partial",
        )

    err = exc_info.value
    assert len(err.violations) == 2
    assert err.violations[0].rule == "irreversible_confidence_threshold"
    assert err.violations[1].rule == "missing_reversibility_class"
    assert err.decision_id == DECISION_ID


def test_sha256_hash_of_decision_text_is_correct(tool, mock_client):
    """decision_text is SHA-256 hashed correctly before being passed to certify_with_confidence."""
    decision_text = "Approve GDPR data deletion for user 42"
    expected_hash = hashlib.sha256(decision_text.encode()).hexdigest()

    tool._run(
        decision_text=decision_text,
        confidence_level=0.95,
        decision_id=DECISION_ID,
        threshold_stage="pre-commitment",
    )

    call_kwargs = mock_client.certify_with_confidence.call_args.kwargs
    assert call_kwargs["file_hash"] == expected_hash


def test_default_file_name_uses_decision_id_and_stage(tool, mock_client):
    """When file_name is not provided, it defaults to '<decision_id>-<stage>.json'."""
    decision_id = "run-2026-04-20"
    stage = "final"

    tool._run(
        decision_text="Final decision payload",
        confidence_level=0.99,
        decision_id=decision_id,
        threshold_stage=stage,
    )

    call_kwargs = mock_client.certify_with_confidence.call_args.kwargs
    assert call_kwargs["file_name"] == f"{decision_id}-{stage}.json"


def test_explicit_file_name_overrides_default(tool, mock_client):
    """When file_name is explicitly provided, it is passed through unchanged."""
    custom_name = "custom-artifact.json"

    tool._run(
        decision_text="Some decision",
        confidence_level=0.9,
        decision_id=DECISION_ID,
        threshold_stage="partial",
        file_name=custom_name,
    )

    call_kwargs = mock_client.certify_with_confidence.call_args.kwargs
    assert call_kwargs["file_name"] == custom_name


def test_pre_computed_file_hash_used_when_decision_text_empty(tool, mock_client):
    """When decision_text is empty, the provided file_hash is passed directly."""
    pre_computed = "b" * 64

    tool._run(
        decision_text="",
        file_hash=pre_computed,
        confidence_level=0.9,
        decision_id=DECISION_ID,
        threshold_stage="pre-commitment",
    )

    call_kwargs = mock_client.certify_with_confidence.call_args.kwargs
    assert call_kwargs["file_hash"] == pre_computed


def test_decision_text_takes_precedence_over_file_hash(tool, mock_client):
    """decision_text hash is used even when file_hash is also provided."""
    decision_text = "Text to hash"
    expected_hash = hashlib.sha256(decision_text.encode()).hexdigest()
    pre_computed = "c" * 64

    tool._run(
        decision_text=decision_text,
        file_hash=pre_computed,
        confidence_level=0.9,
        decision_id=DECISION_ID,
        threshold_stage="pre-commitment",
    )

    call_kwargs = mock_client.certify_with_confidence.call_args.kwargs
    assert call_kwargs["file_hash"] == expected_hash


def test_raises_value_error_when_no_hash_source(tool, mock_client):
    """ValueError is raised when neither decision_text nor file_hash is supplied.

    certify_with_confidence and get_policy_check must not be called — the error
    fires before any network or compliance work begins.
    """
    with pytest.raises(ValueError, match="Either decision_text or file_hash must be provided"):
        tool._run(
            decision_text="",
            file_hash=None,
            confidence_level=0.9,
            decision_id=DECISION_ID,
            threshold_stage="pre-commitment",
        )

    mock_client.certify_with_confidence.assert_not_called()
    mock_client.get_policy_check.assert_not_called()


def test_policy_violation_error_message_contains_decision_id(tool, mock_client):
    """The PolicyViolationError message includes the decision_id for traceability."""
    violations = [
        PolicyViolation(
            proof_id="proof-004",
            confidence_level=0.5,
            reversibility_class="irreversible",
            threshold_stage="partial",
            threshold=0.95,
            rule="some_rule",
        )
    ]
    mock_client.get_policy_check.return_value = _make_violation_check(violations)

    with pytest.raises(PolicyViolationError) as exc_info:
        tool._run(
            decision_text="A decision",
            confidence_level=0.5,
            decision_id=DECISION_ID,
            threshold_stage="pre-commitment",
        )

    assert DECISION_ID in str(exc_info.value)


def test_violation_error_message_contains_rule_and_proof_id(tool, mock_client):
    """The PolicyViolationError message includes the rule and proof_id for each violation."""
    violations = [
        PolicyViolation(
            proof_id="proof-005",
            confidence_level=0.3,
            reversibility_class="irreversible",
            threshold_stage="pre-commitment",
            threshold=0.95,
            rule="irreversible_confidence_threshold",
        )
    ]
    mock_client.get_policy_check.return_value = _make_violation_check(violations)

    with pytest.raises(PolicyViolationError) as exc_info:
        tool._run(
            decision_text="Risky action",
            confidence_level=0.3,
            decision_id=DECISION_ID,
            threshold_stage="pre-commitment",
        )

    error_message = str(exc_info.value)
    assert "POLICY VIOLATION" in error_message
    assert "irreversible_confidence_threshold" in error_message
    assert "proof-005" in error_message


# ---------------------------------------------------------------------------
# Async (_arun) tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_arun_successful_certification_returns_transaction_hash(tool, mock_client):
    """_arun happy path: returns the transaction_hash when the policy check passes."""
    result = await tool._arun(
        decision_text="Approve GDPR data deletion",
        confidence_level=0.97,
        decision_id=DECISION_ID,
        threshold_stage="pre-commitment",
    )

    assert result == TRANSACTION_HASH
    mock_client.certify_with_confidence.assert_called_once()
    mock_client.get_policy_check.assert_called_once_with(DECISION_ID)


@pytest.mark.asyncio
async def test_arun_policy_violation_raises_policy_violation_error(tool, mock_client):
    """_arun propagates PolicyViolationError when the policy check fails."""
    violations = [
        PolicyViolation(
            proof_id="proof-006",
            confidence_level=0.5,
            reversibility_class="irreversible",
            threshold_stage="final",
            threshold=0.95,
            rule="irreversible_confidence_threshold",
        )
    ]
    mock_client.get_policy_check.return_value = _make_violation_check(violations)

    with pytest.raises(PolicyViolationError):
        await tool._arun(
            decision_text="Delete production database",
            confidence_level=0.5,
            decision_id=DECISION_ID,
            threshold_stage="final",
            reversibility_class="irreversible",
        )


@pytest.mark.asyncio
async def test_arun_raises_value_error_when_no_hash_source(tool, mock_client):
    """_arun raises ValueError when neither decision_text nor file_hash is provided."""
    with pytest.raises(ValueError, match="Either decision_text or file_hash must be provided"):
        await tool._arun(
            decision_text="",
            file_hash=None,
            confidence_level=0.9,
            decision_id=DECISION_ID,
            threshold_stage="pre-commitment",
        )

    mock_client.certify_with_confidence.assert_not_called()
    mock_client.get_policy_check.assert_not_called()


@pytest.mark.asyncio
async def test_arun_sha256_hash_of_decision_text_is_correct(tool, mock_client):
    """_arun hashes decision_text with SHA-256 before calling certify_with_confidence."""
    decision_text = "Async GDPR data deletion for user 99"
    expected_hash = hashlib.sha256(decision_text.encode()).hexdigest()

    await tool._arun(
        decision_text=decision_text,
        confidence_level=0.95,
        decision_id=DECISION_ID,
        threshold_stage="pre-commitment",
    )

    call_kwargs = mock_client.certify_with_confidence.call_args.kwargs
    assert call_kwargs["file_hash"] == expected_hash


# ---------------------------------------------------------------------------
# Privacy: `why` supplied via the LangChain tool route is fingerprint-only
# ---------------------------------------------------------------------------


@responses.activate
def test_langchain_tool_route_fingerprints_why():
    """A `why` passed through the LangChain tool never reaches the wire as plaintext."""
    responses.add(
        responses.POST,
        f"{BASE}/api/proof",
        json={
            "id": "proof-lc",
            "fileName": f"{DECISION_ID}-pre-commitment.json",
            "fileHash": "a" * 64,
            "transactionHash": TRANSACTION_HASH,
            "transactionUrl": "",
            "createdAt": "",
        },
        status=201,
    )
    responses.add(
        responses.GET,
        f"{BASE}/api/proofs/policy-check",
        json={
            "decision_id": DECISION_ID,
            "policy_compliant": True,
            "policy_violations": [],
            "total_anchors": 1,
            "checked_at": "2026-04-20T10:00:00Z",
        },
        status=200,
    )

    real_client = XProofClient(api_key="pm_test")
    tool = XProofCertifyTool(api_key="pm_test", author="test-agent", client=real_client)

    raw_why = "delete PII because retention window expired for EU users"
    result = tool._run(
        decision_text="Approve GDPR data deletion",
        confidence_level=0.97,
        decision_id=DECISION_ID,
        threshold_stage="pre-commitment",
        why=raw_why,
    )
    assert result == TRANSACTION_HASH

    raw_body = responses.calls[0].request.body
    body = raw_body.decode("utf-8") if isinstance(raw_body, (bytes, bytearray)) else raw_body
    meta = json.loads(body)["metadata"]
    assert meta["why"] == hashlib.sha256(raw_why.encode("utf-8")).hexdigest()
    assert raw_why not in body
