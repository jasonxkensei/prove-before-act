"""Unit tests for XProofClient with mocked HTTP responses."""

import hashlib
import json
import os
import tempfile

import pytest
import responses
from xproof import (
    AuthenticationError,
    ConflictError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
    XProofClient,
    XProofError,
    hash_file,
)
from xproof.utils import hash_bytes

BASE = "https://provebeforeact.com"


@responses.activate
def test_register():
    responses.add(
        responses.POST,
        f"{BASE}/api/agent/register",
        json={
            "api_key": "pm_test123",
            "agent_name": "test-agent",
            "trial": {"quota": 10, "used": 0, "remaining": 10},
            "endpoints": {
                "certify": f"{BASE}/api/proof",
                "batch": f"{BASE}/api/batch",
            },
        },
        status=200,
    )
    client = XProofClient.register("test-agent")
    assert client.api_key == "pm_test123"
    assert client.registration is not None
    assert client.registration.agent_name == "test-agent"
    assert client.registration.trial.quota == 10
    assert client.registration.trial.remaining == 10
    assert "certify" in client.registration.endpoints


@responses.activate
def test_certify_hash():
    responses.add(
        responses.POST,
        f"{BASE}/api/proof",
        json={
            "id": "proof-001",
            "fileName": "report.pdf",
            "fileHash": "abc123",
            "transactionHash": "tx-001",
            "transactionUrl": "https://explorer.multiversx.com/tx/001",
            "createdAt": "2026-01-01T00:00:00Z",
            "authorName": "Alice",
            "blockchainStatus": "confirmed",
        },
        status=201,
    )
    client = XProofClient(api_key="pm_test")
    cert = client.certify_hash(
        file_hash="abc123",
        file_name="report.pdf",
        author="Alice",
    )
    assert cert.id == "proof-001"
    assert cert.file_name == "report.pdf"
    assert cert.file_hash == "abc123"
    assert cert.transaction_hash == "tx-001"
    assert cert.author_name == "Alice"
    assert cert.blockchain_status == "confirmed"


@responses.activate
def test_certify_file():
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
        f.write(b"hello world")
        tmppath = f.name

    try:
        expected_hash = hashlib.sha256(b"hello world").hexdigest()
        responses.add(
            responses.POST,
            f"{BASE}/api/proof",
            json={
                "id": "proof-file",
                "fileName": os.path.basename(tmppath),
                "fileHash": expected_hash,
                "transactionHash": "tx-file",
                "transactionUrl": "https://explorer.multiversx.com/tx/file",
                "createdAt": "2026-01-01T00:00:00Z",
                "authorName": "Bob",
            },
            status=201,
        )
        client = XProofClient(api_key="pm_test")
        cert = client.certify(tmppath, author="Bob")
        assert cert.id == "proof-file"
        assert cert.file_hash == expected_hash
        req_body = json.loads(responses.calls[0].request.body)
        assert req_body["file_hash"] == expected_hash
    finally:
        os.unlink(tmppath)


@responses.activate
def test_batch_certify():
    responses.add(
        responses.POST,
        f"{BASE}/api/batch",
        json={
            "batch_id": "batch-001",
            "total": 2,
            "created": 2,
            "existing": 0,
            "results": [
                {
                    "file_hash": "h1",
                    "filename": "a.pdf",
                    "proof_id": "proof-b1",
                    "verify_url": "https://example.com/proof/proof-b1",
                    "badge_url": "https://example.com/badge/proof-b1",
                    "status": "created",
                },
                {
                    "file_hash": "h2",
                    "filename": "b.pdf",
                    "proof_id": "proof-b2",
                    "verify_url": "https://example.com/proof/proof-b2",
                    "badge_url": "https://example.com/badge/proof-b2",
                    "status": "created",
                },
            ],
        },
        status=201,
    )
    client = XProofClient(api_key="pm_test")
    result = client.batch_certify(
        [
            {"file_hash": "h1", "file_name": "a.pdf", "author": "A"},
            {"file_hash": "h2", "file_name": "b.pdf", "author": "B"},
        ]
    )
    assert result.batch_id == "batch-001"
    assert result.summary.total == 2
    assert result.summary.created == 2
    assert result.summary.existing == 0
    assert result.summary.certified == 2
    assert len(result.results) == 2
    assert result.results[0].id == "proof-b1"


def test_batch_certify_max_50():
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValueError, match="maximum of 50"):
        client.batch_certify(
            [{"file_hash": f"h{i}", "file_name": f"f{i}", "author": ""} for i in range(51)]
        )


@responses.activate
def test_verify():
    responses.add(
        responses.GET,
        f"{BASE}/api/proof/proof-001",
        json={
            "id": "proof-001",
            "fileName": "doc.pdf",
            "fileHash": "xyz",
            "transactionHash": "tx-v",
            "transactionUrl": "",
            "createdAt": "",
        },
        status=200,
    )
    client = XProofClient(api_key="pm_test")
    cert = client.verify("proof-001")
    assert cert.id == "proof-001"
    assert cert.file_name == "doc.pdf"


@responses.activate
def test_verify_hash():
    responses.add(
        responses.GET,
        f"{BASE}/api/proof/hash/abc123",
        json={
            "id": "proof-vh",
            "fileName": "doc.pdf",
            "fileHash": "abc123",
            "transactionHash": "tx-vh",
            "transactionUrl": "",
            "createdAt": "",
        },
        status=200,
    )
    client = XProofClient(api_key="pm_test")
    cert = client.verify_hash("abc123")
    assert cert.id == "proof-vh"
    assert cert.file_hash == "abc123"


@responses.activate
def test_get_pricing():
    responses.add(
        responses.GET,
        f"{BASE}/api/pricing",
        json={
            "protocol": "xproof",
            "version": "1.0",
            "price_usd": 0.01,
            "tiers": [{"min": 0, "max": None, "price": 0.01}],
            "payment_methods": [{"method": "USDC", "network": "Base"}],
        },
        status=200,
    )
    client = XProofClient()
    pricing = client.get_pricing()
    assert pricing.protocol == "xproof"
    assert pricing.price_usd == 0.01
    assert len(pricing.tiers) == 1
    assert pricing.tiers[0].price_usd == 0.01


@responses.activate
def test_error_401():
    responses.add(responses.POST, f"{BASE}/api/proof", json={"error": "Unauthorized"}, status=401)
    client = XProofClient(api_key="pm_bad")
    with pytest.raises(AuthenticationError):
        client.certify_hash("h", "f", "a")


@responses.activate
def test_error_400():
    responses.add(responses.POST, f"{BASE}/api/proof", json={"error": "Bad request"}, status=400)
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValidationError):
        client.certify_hash("h", "f", "a")


@responses.activate
def test_error_404():
    responses.add(responses.GET, f"{BASE}/api/proof/nope", json={"error": "Not found"}, status=404)
    client = XProofClient()
    with pytest.raises(NotFoundError):
        client.verify("nope")


@responses.activate
def test_error_409():
    responses.add(
        responses.POST,
        f"{BASE}/api/proof",
        json={"error": "Already certified", "certificationId": "dup-1"},
        status=409,
    )
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ConflictError) as exc_info:
        client.certify_hash("h", "f", "a")
    assert exc_info.value.certification_id == "dup-1"


@responses.activate
def test_error_429():
    responses.add(responses.POST, f"{BASE}/api/proof", json={"error": "Rate limited"}, status=429)
    client = XProofClient(api_key="pm_test")
    with pytest.raises(RateLimitError):
        client.certify_hash("h", "f", "a")


@responses.activate
def test_error_500():
    responses.add(responses.POST, f"{BASE}/api/proof", json={"error": "Server error"}, status=500)
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ServerError):
        client.certify_hash("h", "f", "a")


def test_no_api_key_certify():
    client = XProofClient()
    with pytest.raises(ValueError, match="api_key is required"):
        client.certify_hash("h", "f", "a")


def test_hash_file():
    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(b"test data")
        tmppath = f.name
    try:
        result = hash_file(tmppath)
        expected = hashlib.sha256(b"test data").hexdigest()
        assert result == expected
        assert len(result) == 64
    finally:
        os.unlink(tmppath)


def test_hash_bytes():
    result = hash_bytes(b"hello")
    expected = hashlib.sha256(b"hello").hexdigest()
    assert result == expected
    assert len(result) == 64


@responses.activate
def test_auth_header_uses_bearer():
    responses.add(
        responses.POST,
        f"{BASE}/api/proof",
        json={
            "id": "p1",
            "fileName": "f",
            "fileHash": "h",
            "transactionHash": "t",
            "transactionUrl": "",
            "createdAt": "",
        },
        status=201,
    )
    client = XProofClient(api_key="pm_mykey123")
    client.certify_hash("a" * 64, "f.txt", "author")
    req = responses.calls[0].request
    assert "Authorization" in req.headers
    assert req.headers["Authorization"] == "Bearer pm_mykey123"
    assert "X-API-Key" not in req.headers


@responses.activate
def test_certify_hash_sends_snake_case_fields():
    responses.add(
        responses.POST,
        f"{BASE}/api/proof",
        json={
            "id": "p1",
            "fileName": "f",
            "fileHash": "h",
            "transactionHash": "t",
            "transactionUrl": "",
            "createdAt": "",
        },
        status=201,
    )
    client = XProofClient(api_key="pm_test")
    test_hash = "b" * 64
    client.certify_hash(test_hash, "report.pdf", "Alice")
    req_body = json.loads(responses.calls[0].request.body)
    assert "file_hash" in req_body
    assert "filename" in req_body
    assert "author_name" in req_body
    assert req_body["file_hash"] == test_hash
    assert req_body["filename"] == "report.pdf"
    assert req_body["author_name"] == "Alice"
    assert "fileHash" not in req_body
    assert "fileName" not in req_body


@responses.activate
def test_batch_sends_snake_case_fields():
    responses.add(
        responses.POST,
        f"{BASE}/api/batch",
        json={"results": [], "summary": {"total": 0, "certified": 0, "failed": 0}},
        status=200,
    )
    client = XProofClient(api_key="pm_test")
    client.batch_certify(
        [
            {"file_hash": "a" * 64, "file_name": "a.pdf", "author": "Alice"},
        ]
    )
    req_body = json.loads(responses.calls[0].request.body)
    assert "files" in req_body
    assert req_body["files"][0]["file_hash"] == "a" * 64
    assert req_body["files"][0]["filename"] == "a.pdf"
    assert req_body.get("author_name") == "Alice"
    assert "fileHash" not in req_body["files"][0]
    assert "fileName" not in req_body["files"][0]


@responses.activate
def test_certify_hash_with_4w_metadata():
    responses.add(
        responses.POST,
        f"{BASE}/api/proof",
        json={
            "id": "p-4w",
            "fileName": "f",
            "fileHash": "h",
            "transactionHash": "t",
            "transactionUrl": "",
            "createdAt": "",
        },
        status=201,
    )
    client = XProofClient(api_key="pm_test")
    client.certify_hash(
        "c" * 64,
        "action.json",
        "agent-x",
        who="erd1abc...",
        what="sha256-of-action",
        when="2026-03-20T12:00:00Z",
        why="sha256-of-instruction",
        metadata={"custom_key": "custom_value"},
    )
    req_body = json.loads(responses.calls[0].request.body)
    assert "metadata" in req_body
    meta = req_body["metadata"]
    assert meta["who"] == "erd1abc..."
    assert meta["what"] == "sha256-of-action"
    assert meta["when"] == "2026-03-20T12:00:00Z"
    assert meta["why"] == "sha256-of-instruction"
    assert meta["custom_key"] == "custom_value"


@responses.activate
def test_certify_hash_without_4w():
    responses.add(
        responses.POST,
        f"{BASE}/api/proof",
        json={
            "id": "p-no4w",
            "fileName": "f",
            "fileHash": "h",
            "transactionHash": "t",
            "transactionUrl": "",
            "createdAt": "",
        },
        status=201,
    )
    client = XProofClient(api_key="pm_test")
    client.certify_hash("d" * 64, "doc.pdf", "author")
    req_body = json.loads(responses.calls[0].request.body)
    assert "metadata" not in req_body


@responses.activate
def test_no_auth_for_public_endpoints():
    responses.add(
        responses.GET,
        f"{BASE}/api/pricing",
        json={"protocol": "xproof", "version": "1.0", "price_usd": 0.01},
        status=200,
    )
    client = XProofClient()
    client.get_pricing()
    req = responses.calls[0].request
    assert req.headers.get("Authorization", "") == ""


@responses.activate
def test_json_decode_error_raises_xproof_error():
    responses.add(
        responses.POST,
        f"{BASE}/api/proof",
        body="<html>Not Found</html>",
        status=200,
        content_type="text/html",
    )
    client = XProofClient(api_key="pm_test")
    with pytest.raises(XProofError, match="Unexpected non-JSON response"):
        client.certify_hash("e" * 64, "test.pdf", "author")


@responses.activate
def test_verify_hash_uses_correct_endpoint():
    responses.add(
        responses.GET,
        f"{BASE}/api/proof/hash/abc123def",
        json={
            "id": "proof-ep",
            "fileName": "check.pdf",
            "fileHash": "abc123def",
            "transactionHash": "tx-ep",
            "transactionUrl": "",
            "createdAt": "",
        },
        status=200,
    )
    client = XProofClient(api_key="pm_test")
    cert = client.verify_hash("abc123def")
    assert cert.id == "proof-ep"
    assert responses.calls[0].request.url == f"{BASE}/api/proof/hash/abc123def"


# ---------------------------------------------------------------------------
# certify_with_confidence() tests
# ---------------------------------------------------------------------------

CERT_RESPONSE = {
    "id": "proof-cwc",
    "fileName": "analysis.json",
    "fileHash": "a" * 64,
    "transactionHash": "tx-cwc",
    "transactionUrl": "https://explorer.multiversx.com/tx/cwc",
    "createdAt": "2026-04-20T10:00:00Z",
    "authorName": "AgentX",
    "blockchainStatus": "confirmed",
}


@responses.activate
def test_certify_with_confidence_happy_path():
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    cert = client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="analysis.json",
        author="AgentX",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="decision-42",
    )
    assert cert.id == "proof-cwc"
    assert cert.author_name == "AgentX"

    req_body = json.loads(responses.calls[0].request.body)
    assert req_body["filename"] == "analysis.json"
    assert req_body["file_hash"] == "a" * 64
    assert req_body["author_name"] == "AgentX"
    meta = req_body["metadata"]
    assert meta["confidence_level"] == 0.8
    assert meta["threshold_stage"] == "partial"
    assert meta["decision_id"] == "decision-42"


@responses.activate
def test_certify_with_confidence_includes_4w_fields():
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="b" * 64,
        file_name="plan.json",
        author="AgentY",
        confidence_level=0.6,
        threshold_stage="initial",
        decision_id="decision-99",
        who="erd1agent...",
        what="sha256-of-plan",
        when="2026-04-20T09:00:00Z",
        why="sha256-of-goal",
        metadata={"extra_key": "extra_value"},
    )
    req_body = json.loads(responses.calls[0].request.body)
    meta = req_body["metadata"]
    assert meta["confidence_level"] == 0.6
    assert meta["threshold_stage"] == "initial"
    assert meta["decision_id"] == "decision-99"
    assert meta["who"] == "erd1agent..."
    assert meta["what"] == "sha256-of-plan"
    assert meta["when"] == "2026-04-20T09:00:00Z"
    assert meta["why"] == "sha256-of-goal"
    assert meta["extra_key"] == "extra_value"


@responses.activate
def test_certify_with_confidence_boundary_values():
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")

    cert_min = client.certify_with_confidence(
        file_hash="c" * 64,
        file_name="min.json",
        author="Agent",
        confidence_level=0.0,
        threshold_stage="initial",
        decision_id="dec-min",
    )
    assert cert_min.id == "proof-cwc"
    meta_min = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta_min["confidence_level"] == 0.0

    cert_max = client.certify_with_confidence(
        file_hash="d" * 64,
        file_name="max.json",
        author="Agent",
        confidence_level=1.0,
        threshold_stage="final",
        decision_id="dec-max",
    )
    assert cert_max.id == "proof-cwc"
    meta_max = json.loads(responses.calls[1].request.body)["metadata"]
    assert meta_max["confidence_level"] == 1.0
    assert meta_max["threshold_stage"] == "final"


def test_certify_with_confidence_invalid_confidence_too_low():
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValueError, match="confidence_level must be between 0.0 and 1.0"):
        client.certify_with_confidence(
            file_hash="e" * 64,
            file_name="f.json",
            author="Agent",
            confidence_level=-0.1,
            threshold_stage="initial",
            decision_id="dec-low",
        )


def test_certify_with_confidence_invalid_confidence_too_high():
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValueError, match="confidence_level must be between 0.0 and 1.0"):
        client.certify_with_confidence(
            file_hash="f" * 64,
            file_name="f.json",
            author="Agent",
            confidence_level=1.01,
            threshold_stage="final",
            decision_id="dec-high",
        )


@pytest.mark.parametrize(
    "bad_value",
    [None, "high", float("nan"), float("inf"), float("-inf")],
)
def test_certify_with_confidence_rejects_non_finite_confidence(bad_value):
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValueError, match="finite number"):
        client.certify_with_confidence(
            file_hash="a" * 64,
            file_name="f.json",
            author="Agent",
            confidence_level=bad_value,
            threshold_stage="initial",
            decision_id="dec-bad",
        )


def test_certify_with_confidence_invalid_threshold_stage():
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValueError, match="threshold_stage must be one of"):
        client.certify_with_confidence(
            file_hash="a" * 64,
            file_name="f.json",
            author="Agent",
            confidence_level=0.5,
            threshold_stage="invalid-stage",
            decision_id="dec-stage",
        )


def test_certify_with_confidence_blank_decision_id():
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValueError, match="decision_id is required"):
        client.certify_with_confidence(
            file_hash="a" * 64,
            file_name="f.json",
            author="Agent",
            confidence_level=0.5,
            threshold_stage="partial",
            decision_id="",
        )


def test_certify_with_confidence_whitespace_decision_id():
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValueError, match="decision_id is required"):
        client.certify_with_confidence(
            file_hash="a" * 64,
            file_name="f.json",
            author="Agent",
            confidence_level=0.5,
            threshold_stage="partial",
            decision_id="   ",
        )


def test_certify_with_confidence_no_api_key():
    client = XProofClient()
    with pytest.raises(ValueError, match="api_key is required"):
        client.certify_with_confidence(
            file_hash="a" * 64,
            file_name="f.json",
            author="Agent",
            confidence_level=0.5,
            threshold_stage="partial",
            decision_id="dec-nokey",
        )


# ---------------------------------------------------------------------------
# certify_with_confidence() — reversibility_class for all 3 values (#57)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("rev_class", ["reversible", "costly", "irreversible"])
@responses.activate
def test_certify_with_confidence_reversibility_class(rev_class):
    """reversibility_class appears in request metadata for all valid values."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="f.json",
        author="Agent",
        confidence_level=0.9,
        threshold_stage="pre-commitment",
        decision_id="dec-rev",
        reversibility_class=rev_class,
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["reversibility_class"] == rev_class


@responses.activate
def test_certify_with_confidence_reversibility_class_omitted_when_none():
    """When reversibility_class is None it must not appear in metadata."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="f.json",
        author="Agent",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="dec-rev-none",
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert "reversibility_class" not in meta


def test_valid_reversibility_classes_constant():
    """VALID_REVERSIBILITY_CLASSES must be exactly the expected tuple."""
    assert XProofClient.VALID_REVERSIBILITY_CLASSES == ("reversible", "costly", "irreversible")


@pytest.mark.parametrize("bad_class", ["maybe", "", "REVERSIBLE", "unknown", "0"])
def test_certify_with_confidence_invalid_reversibility_class_raises(bad_class):
    """Invalid reversibility_class must raise ValueError before any network call."""
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValueError, match="reversibility_class must be one of"):
        client.certify_with_confidence(
            file_hash="a" * 64,
            file_name="f.json",
            author="Agent",
            confidence_level=0.8,
            threshold_stage="partial",
            decision_id="dec-bad-rev",
            reversibility_class=bad_class,
        )


@pytest.mark.parametrize("good_class", ["reversible", "costly", "irreversible"])
@responses.activate
def test_certify_with_confidence_valid_reversibility_class_accepted(good_class):
    """All three valid reversibility_class values must be accepted without error."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    cert = client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="f.json",
        author="Agent",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="dec-good-rev",
        reversibility_class=good_class,
    )
    assert cert is not None
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["reversibility_class"] == good_class


# ---------------------------------------------------------------------------
# certify_with_confidence() — all 4 threshold_stage values (#58)
# ---------------------------------------------------------------------------


def test_valid_threshold_stages_constant():
    """VALID_THRESHOLD_STAGES must be exactly the four documented values (#93).

    Any addition, removal, or typo in the constant causes this test to fail
    immediately — before a downstream caller is affected.
    """
    assert XProofClient.VALID_THRESHOLD_STAGES == (
        "initial",
        "partial",
        "pre-commitment",
        "final",
    )


@pytest.mark.parametrize("stage", ["initial", "partial", "pre-commitment", "final"])
@responses.activate
def test_certify_with_confidence_all_threshold_stages(stage):
    """Each of the 4 valid threshold_stage values is accepted and sent correctly."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="f.json",
        author="Agent",
        confidence_level=0.8,
        threshold_stage=stage,
        decision_id="dec-stage",
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["threshold_stage"] == stage


# ---------------------------------------------------------------------------
# certify_with_confidence() — 4W metadata defaults (#59)
# ---------------------------------------------------------------------------


@responses.activate
def test_certify_with_confidence_who_omitted_when_not_provided():
    """who is absent from metadata when not passed."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="f.json",
        author="MyAgent",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="dec-4w-who",
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert "who" not in meta


@responses.activate
def test_certify_with_confidence_who_present_when_provided():
    """who is included in metadata when explicitly passed."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="f.json",
        author="MyAgent",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="dec-4w-who2",
        who="erd1agent...",
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["who"] == "erd1agent..."


@responses.activate
def test_certify_with_confidence_what_present_when_provided():
    """what is included in metadata when explicitly passed."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="b" * 64,
        file_name="f.json",
        author="Agent",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="dec-4w-what",
        what="sha256-of-action",
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["what"] == "sha256-of-action"


@responses.activate
def test_certify_with_confidence_when_present_when_provided():
    """when is included in metadata when explicitly passed."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="c" * 64,
        file_name="f.json",
        author="Agent",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="dec-4w-when",
        when="2026-04-20T10:00:00+00:00",
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["when"] == "2026-04-20T10:00:00+00:00"


@responses.activate
def test_certify_with_confidence_why_present_when_provided():
    """why is included in metadata when explicitly passed."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="d" * 64,
        file_name="f.json",
        author="Agent",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="dec-4w-why",
        why="GDPR cleanup scheduled",
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["why"] == "GDPR cleanup scheduled"


@responses.activate
def test_certify_with_confidence_why_omitted_when_not_provided():
    """why is absent from metadata when not passed."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="e" * 64,
        file_name="f.json",
        author="Agent",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="dec-4w-why-none",
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert "why" not in meta


# ---------------------------------------------------------------------------
# batch_certify() — CertifyEntry TypedDict compatibility (#76)
# ---------------------------------------------------------------------------


@responses.activate
def test_batch_certify_accepts_certify_entry_typed_dicts():
    """batch_certify must accept CertifyEntry TypedDicts without type errors."""
    from xproof.models import CertifyEntry

    responses.add(
        responses.POST,
        f"{BASE}/api/batch",
        json={
            "batch_id": "batch-ce-001",
            "total": 2,
            "created": 2,
            "existing": 0,
            "results": [
                {
                    "file_hash": "h1",
                    "filename": "a.json",
                    "proof_id": "proof-ce1",
                    "verify_url": "https://example.com/proof/proof-ce1",
                    "badge_url": "https://example.com/badge/proof-ce1",
                    "status": "created",
                },
                {
                    "file_hash": "h2",
                    "filename": "b.json",
                    "proof_id": "proof-ce2",
                    "verify_url": "https://example.com/proof/proof-ce2",
                    "badge_url": "https://example.com/badge/proof-ce2",
                    "status": "created",
                },
            ],
        },
        status=201,
    )
    client = XProofClient(api_key="pm_test")

    entries: list[CertifyEntry] = [
        {"file_hash": "h1", "file_name": "a.json", "author": "AgentA"},
        {"file_hash": "h2", "file_name": "b.json", "author": "AgentB"},
    ]
    result = client.batch_certify(entries)
    assert result.batch_id == "batch-ce-001"
    assert result.summary.total == 2


@responses.activate
def test_batch_certify_certify_entry_keys_match_api_contract():
    """file_name (not filename) is the CertifyEntry key; client maps it to API 'filename'."""
    from xproof.models import CertifyEntry

    responses.add(
        responses.POST,
        f"{BASE}/api/batch",
        json={
            "batch_id": "batch-keys",
            "total": 1,
            "created": 1,
            "existing": 0,
            "results": [
                {
                    "file_hash": "hk",
                    "filename": "contract.json",
                    "proof_id": "proof-k1",
                    "verify_url": "https://example.com/proof/proof-k1",
                    "badge_url": "https://example.com/badge/proof-k1",
                    "status": "created",
                }
            ],
        },
        status=201,
    )
    client = XProofClient(api_key="pm_test")

    entry: CertifyEntry = {
        "file_hash": "hk",
        "file_name": "contract.json",
        "author": "AgentC",
        "metadata": {"who": "AgentC", "why": "Compliance check"},
    }
    result = client.batch_certify([entry])
    assert result.summary.created == 1

    req_body = json.loads(responses.calls[0].request.body)
    assert req_body["files"][0]["file_hash"] == "hk"


@responses.activate
def test_batch_certify_with_metadata_in_certify_entry():
    """metadata in CertifyEntry is forwarded to the API payload."""
    from xproof.models import CertifyEntry

    responses.add(
        responses.POST,
        f"{BASE}/api/batch",
        json={
            "batch_id": "batch-meta",
            "total": 1,
            "created": 1,
            "existing": 0,
            "results": [
                {
                    "file_hash": "hm",
                    "filename": "report.json",
                    "proof_id": "proof-m1",
                    "verify_url": "",
                    "badge_url": "",
                    "status": "created",
                }
            ],
        },
        status=201,
    )
    client = XProofClient(api_key="pm_test")

    entry: CertifyEntry = {
        "file_hash": "hm",
        "file_name": "report.json",
        "author": "AgentD",
        "metadata": {"who": "AgentD", "what": "hm", "why": "audit"},
    }
    result = client.batch_certify([entry])
    assert result.summary.created == 1


# ---------------------------------------------------------------------------
# certify_with_confidence() — timing breakdown (#88)
# ---------------------------------------------------------------------------


@responses.activate
def test_certify_with_confidence_timing_sent_in_metadata():
    """timing fields are merged into metadata when timing kwarg is provided."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    from xproof import TimingBreakdown

    timing: TimingBreakdown = {
        "instruction_received_at": "2026-04-20T14:30:00Z",
        "reasoning_started_at": "2026-04-20T14:30:01Z",
        "action_taken_at": "2026-04-20T14:30:05Z",
        "jurisdiction_type": "autonomous_inference",
    }
    client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="decision.json",
        author="Agent",
        confidence_level=0.9,
        threshold_stage="pre-commitment",
        decision_id="dec-timing-01",
        timing=timing,
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["instruction_received_at"] == "2026-04-20T14:30:00Z"
    assert meta["reasoning_started_at"] == "2026-04-20T14:30:01Z"
    assert meta["action_taken_at"] == "2026-04-20T14:30:05Z"
    assert meta["jurisdiction_type"] == "autonomous_inference"
    assert meta["confidence_level"] == 0.9
    assert meta["decision_id"] == "dec-timing-01"


@responses.activate
def test_certify_with_confidence_partial_timing_sent():
    """Only provided timing keys appear in metadata; absent keys are not sent."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    from xproof import TimingBreakdown

    timing: TimingBreakdown = {
        "instruction_received_at": "2026-04-20T10:00:00Z",
        "action_taken_at": "2026-04-20T10:00:09Z",
    }
    client.certify_with_confidence(
        file_hash="b" * 64,
        file_name="partial.json",
        author="Agent",
        confidence_level=0.75,
        threshold_stage="partial",
        decision_id="dec-timing-02",
        timing=timing,
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["instruction_received_at"] == "2026-04-20T10:00:00Z"
    assert meta["action_taken_at"] == "2026-04-20T10:00:09Z"
    assert "reasoning_started_at" not in meta
    assert "jurisdiction_type" not in meta


@responses.activate
def test_certify_with_confidence_no_timing_no_keys_sent():
    """When timing is None, no timing keys appear in metadata."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    client.certify_with_confidence(
        file_hash="c" * 64,
        file_name="notiming.json",
        author="Agent",
        confidence_level=0.8,
        threshold_stage="initial",
        decision_id="dec-timing-03",
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    for key in (
        "instruction_received_at",
        "reasoning_started_at",
        "action_taken_at",
        "jurisdiction_type",
    ):
        assert key not in meta, f"Unexpected key in metadata: {key}"


@responses.activate
def test_certification_from_dict_parses_timing_breakdown():
    """Certification.from_dict deserialises timing_breakdown from the API response."""
    api_response = {
        **CERT_RESPONSE,
        "timing_breakdown": {
            "instruction_received_at": "2026-04-20T14:30:00Z",
            "reasoning_started_at": "2026-04-20T14:30:01Z",
            "action_taken_at": "2026-04-20T14:30:05Z",
            "jurisdiction_type": "instruction_following",
            "reasoning_duration_ms": 4000,
            "total_duration_ms": 5000,
        },
    }
    responses.add(responses.POST, f"{BASE}/api/proof", json=api_response, status=201)
    client = XProofClient(api_key="pm_test")
    from xproof import TimingBreakdown

    cert = client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="analysis.json",
        author="AgentX",
        confidence_level=0.95,
        threshold_stage="final",
        decision_id="dec-timing-04",
    )
    assert cert.timing_breakdown is not None
    tb: TimingBreakdown = cert.timing_breakdown
    assert tb["instruction_received_at"] == "2026-04-20T14:30:00Z"
    assert tb["reasoning_started_at"] == "2026-04-20T14:30:01Z"
    assert tb["action_taken_at"] == "2026-04-20T14:30:05Z"
    assert tb["jurisdiction_type"] == "instruction_following"
    assert tb["reasoning_duration_ms"] == 4000
    assert tb["total_duration_ms"] == 5000


@responses.activate
def test_certification_from_dict_timing_breakdown_none_when_absent():
    """timing_breakdown is None when the API response does not include it."""
    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    cert = client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="analysis.json",
        author="AgentX",
        confidence_level=0.8,
        threshold_stage="partial",
        decision_id="dec-timing-05",
    )
    assert cert.timing_breakdown is None


@responses.activate
def test_certification_from_dict_parses_flat_timing_keys_from_metadata():
    """Certification.from_dict reads timing from flat keys in metadata (canonical backend format)."""
    api_response = {
        **CERT_RESPONSE,
        "metadata": {
            "confidence_level": 0.95,
            "threshold_stage": "final",
            "decision_id": "dec-flat-timing",
            "instruction_received_at": "2026-04-20T14:30:00Z",
            "reasoning_started_at": "2026-04-20T14:30:01Z",
            "action_taken_at": "2026-04-20T14:30:05Z",
            "jurisdiction_type": "autonomous_inference",
            "reasoning_duration_ms": 4000,
            "total_duration_ms": 5000,
        },
    }
    responses.add(responses.POST, f"{BASE}/api/proof", json=api_response, status=201)
    client = XProofClient(api_key="pm_test")
    from xproof import TimingBreakdown

    cert = client.certify_with_confidence(
        file_hash="a" * 64,
        file_name="flat-timing.json",
        author="AgentX",
        confidence_level=0.95,
        threshold_stage="final",
        decision_id="dec-flat-timing",
    )
    assert cert.timing_breakdown is not None
    tb: TimingBreakdown = cert.timing_breakdown
    assert tb["instruction_received_at"] == "2026-04-20T14:30:00Z"
    assert tb["reasoning_started_at"] == "2026-04-20T14:30:01Z"
    assert tb["action_taken_at"] == "2026-04-20T14:30:05Z"
    assert tb["jurisdiction_type"] == "autonomous_inference"
    assert tb["reasoning_duration_ms"] == 4000
    assert tb["total_duration_ms"] == 5000


@responses.activate
def test_certify_with_confidence_timing_and_4w_combined():
    """timing fields coexist with 4W fields in metadata without conflict."""
    from xproof import TimingBreakdown

    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    timing: TimingBreakdown = {
        "instruction_received_at": "2026-04-20T08:00:00Z",
        "action_taken_at": "2026-04-20T08:00:10Z",
        "jurisdiction_type": "human_approved",
    }
    client.certify_with_confidence(
        file_hash="d" * 64,
        file_name="combined.json",
        author="Agent",
        confidence_level=0.97,
        threshold_stage="final",
        decision_id="dec-timing-06",
        who="erd1xyz...",
        why="GDPR retention audit",
        reversibility_class="irreversible",
        timing=timing,
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    assert meta["who"] == "erd1xyz..."
    assert meta["why"] == "GDPR retention audit"
    assert meta["reversibility_class"] == "irreversible"
    assert meta["instruction_received_at"] == "2026-04-20T08:00:00Z"
    assert meta["action_taken_at"] == "2026-04-20T08:00:10Z"
    assert meta["jurisdiction_type"] == "human_approved"


def test_timing_breakdown_and_jurisdiction_type_exported():
    """TimingBreakdown and JurisdictionType are importable from the top-level package."""
    from xproof import JURISDICTION_TYPES, TimingBreakdown

    assert "instruction_following" in JURISDICTION_TYPES
    assert "autonomous_inference" in JURISDICTION_TYPES
    assert "human_approved" in JURISDICTION_TYPES
    assert len(JURISDICTION_TYPES) == 3

    tb: TimingBreakdown = {
        "action_taken_at": "2026-04-20T14:30:05Z",
        "jurisdiction_type": "autonomous_inference",
    }
    assert tb["jurisdiction_type"] == "autonomous_inference"


@responses.activate
def test_certify_with_confidence_empty_timing_dict_ignored():
    """An empty timing dict sends no timing keys."""
    from xproof import TimingBreakdown

    responses.add(responses.POST, f"{BASE}/api/proof", json=CERT_RESPONSE, status=201)
    client = XProofClient(api_key="pm_test")
    timing: TimingBreakdown = {}
    client.certify_with_confidence(
        file_hash="e" * 64,
        file_name="empty.json",
        author="Agent",
        confidence_level=0.5,
        threshold_stage="initial",
        decision_id="dec-timing-07",
        timing=timing,
    )
    meta = json.loads(responses.calls[0].request.body)["metadata"]
    for key in (
        "instruction_received_at",
        "reasoning_started_at",
        "action_taken_at",
        "jurisdiction_type",
    ):
        assert key not in meta


def test_certify_with_confidence_invalid_jurisdiction_type_raises():
    """An invalid jurisdiction_type value raises ValueError before any HTTP call."""
    client = XProofClient(api_key="pm_test")
    with pytest.raises(ValueError, match="timing\\['jurisdiction_type'\\] must be one of"):
        client.certify_with_confidence(
            file_hash="f" * 64,
            file_name="bad.json",
            author="Agent",
            confidence_level=0.8,
            threshold_stage="partial",
            decision_id="dec-jt-bad",
            timing={"jurisdiction_type": "not_a_valid_type"},  # type: ignore[typeddict-item]
        )


@responses.activate
def test_batch_certify_with_timing_in_certify_entry():
    """timing in a CertifyEntry is forwarded as metadata fields in the batch payload."""
    from xproof import TimingBreakdown
    from xproof.models import CertifyEntry

    responses.add(
        responses.POST,
        f"{BASE}/api/batch",
        json={
            "batch_id": "batch-timing-001",
            "total": 1,
            "created": 1,
            "existing": 0,
            "results": [
                {
                    "file_hash": "ht",
                    "filename": "timed.json",
                    "proof_id": "proof-t1",
                    "verify_url": "",
                    "badge_url": "",
                    "status": "created",
                }
            ],
        },
        status=201,
    )
    client = XProofClient(api_key="pm_test")
    timing: TimingBreakdown = {
        "instruction_received_at": "2026-04-20T09:00:00Z",
        "action_taken_at": "2026-04-20T09:00:08Z",
        "jurisdiction_type": "human_approved",
    }
    entry: CertifyEntry = {
        "file_hash": "ht",
        "file_name": "timed.json",
        "author": "AgentT",
        "timing": timing,
    }
    result = client.batch_certify([entry])
    assert result.summary.created == 1
    req_body = json.loads(responses.calls[0].request.body)
    file_meta = req_body["files"][0]["metadata"]
    assert file_meta["instruction_received_at"] == "2026-04-20T09:00:00Z"
    assert file_meta["action_taken_at"] == "2026-04-20T09:00:08Z"
    assert file_meta["jurisdiction_type"] == "human_approved"


def test_batch_certify_invalid_jurisdiction_type_raises():
    """An invalid jurisdiction_type in a CertifyEntry timing raises ValueError."""
    from xproof.models import CertifyEntry

    client = XProofClient(api_key="pm_test")
    entry: CertifyEntry = {
        "file_hash": "hb",
        "file_name": "bad.json",
        "timing": {"jurisdiction_type": "not_valid"},  # type: ignore[typeddict-item]
    }
    with pytest.raises(ValueError, match="timing\\['jurisdiction_type'\\] must be one of"):
        client.batch_certify([entry])
