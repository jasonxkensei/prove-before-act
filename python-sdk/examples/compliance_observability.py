"""Compliance violation alerts — runnable observability example.

Demonstrates the pattern from the README "Observability — surfacing violations
in dashboards" section against a fully mocked XProofClient so no real API key
or network access is required.

Run from the python-sdk directory (where the xproof package is installed):

    # Install the package once (if not already installed):
    pip install -e .

    # Then run the example:
    python examples/compliance_observability.py

Expected outcome: structured JSON log lines are printed to stdout and the
script exits 0, confirming the _emit_violation helper and get_confidence_trail
call both behave as documented.
"""

import json
import logging
import sys
import urllib.request
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any, Optional
from unittest.mock import MagicMock, patch

# `xproof` is the legacy module name retained by the canonical prove-before-act distribution.
from xproof.models import ConfidenceTrail, PolicyCheckResult, PolicyViolation

logger = logging.getLogger("xproof.compliance")
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stdout,
    format="%(message)s",
)

VIOLATION_WEBHOOK_URL = None


def _emit_violation(decision_id: str, violation: PolicyViolation) -> None:
    """Emit one structured log line and, optionally, a webhook call."""
    payload = {
        "event": "policy_violation",
        "decision_id": decision_id,
        "rule": violation.rule,
        "proof_id": violation.proof_id,
        "confidence_level": violation.confidence_level,
        "reversibility_class": violation.reversibility_class,
        "threshold_stage": violation.threshold_stage,
        "threshold": violation.threshold,
    }
    logger.error(json.dumps(payload))

    if VIOLATION_WEBHOOK_URL:
        try:
            body = json.dumps(payload).encode()
            req = urllib.request.Request(
                VIOLATION_WEBHOOK_URL,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5):
                pass
        except Exception as exc:
            logger.warning(json.dumps({"event": "webhook_error", "detail": str(exc)}))


def build_mock_client(decision_id: str) -> MagicMock:
    """Return a mock XProofClient pre-loaded with a non-compliant policy check
    and a matching confidence trail so the example works without any network
    calls."""

    violation_data = {
        "proof_id": "proof-retention-demo",
        "confidence_level": 0.6,
        "reversibility_class": "irreversible",
        "threshold_stage": "partial",
        "threshold": 0.95,
        "rule": "data-retention-90d",
    }

    policy_check = PolicyCheckResult.from_dict(
        {
            "decision_id": decision_id,
            "total_anchors": 2,
            "policy_compliant": False,
            "policy_violations": [violation_data],
            "checked_at": "2026-04-20T12:00:00Z",
        }
    )

    trail_raw = {
        "decision_id": decision_id,
        "total_anchors": 2,
        "current_confidence": 0.72,
        "current_stage": "review",
        "is_finalized": False,
        "policy_compliant": False,
        "policy_violations": [violation_data],
        "stages": [
            {
                "proof_id": "proof-stage-1",
                "confidence_level": 0.50,
                "threshold_stage": "draft",
                "reversibility_class": "reversible",
                "anchored_at": "2026-04-20T11:00:00Z",
                "transaction_hash": "0xabc123",
                "transaction_url": "https://explorer.multiversx.com/transactions/0xabc123",
                "policy_violations": [],
            },
            {
                "proof_id": "proof-stage-2",
                "confidence_level": 0.72,
                "threshold_stage": "review",
                "reversibility_class": "costly",
                "anchored_at": "2026-04-20T12:00:00Z",
                "transaction_hash": "0xdef456",
                "transaction_url": "https://explorer.multiversx.com/transactions/0xdef456",
                "policy_violations": [violation_data],
            },
        ],
    }
    trail = ConfidenceTrail.from_dict(trail_raw)

    client = MagicMock()
    client.get_policy_check.return_value = policy_check
    client.get_confidence_trail.return_value = trail
    return client


def run(decision_id: str) -> None:
    """Exercise the observability pattern and verify structured outputs."""

    client = build_mock_client(decision_id)

    check = client.get_policy_check(decision_id)
    assert check.decision_id == decision_id, "get_policy_check must echo back the decision_id"

    emitted: list[dict[str, Any]] = []
    trail_stages = 0

    if not check.policy_compliant:
        for v in check.policy_violations:
            _emit_violation(decision_id, v)
            emitted.append(
                {
                    "rule": v.rule,
                    "proof_id": v.proof_id,
                    "confidence_level": v.confidence_level,
                    "threshold": v.threshold,
                }
            )

        trail = client.get_confidence_trail(decision_id)
        trail_stages = len(trail.stages)
        logger.error(
            json.dumps(
                {
                    "event": "audit_trail",
                    "decision_id": decision_id,
                    "trail": trail.raw,
                }
            )
        )

        assert trail.decision_id == decision_id, "Trail decision_id must match"
        assert trail_stages == 2, "Trail must contain two stage anchors"
        assert trail.stages[1].transaction_hash == "0xdef456", (
            "Second stage transaction hash must be 0xdef456"
        )

    assert len(emitted) == 1, "Exactly one violation must have been emitted"
    assert emitted[0]["rule"] == "data-retention-90d", (
        "Emitted violation rule must match the stubbed rule"
    )

    client.get_policy_check.assert_called_once_with(decision_id)
    client.get_confidence_trail.assert_called_once_with(decision_id)

    print(
        json.dumps(
            {
                "result": "ok",
                "decision_id": decision_id,
                "violations": len(emitted),
                "trail_stages": trail_stages,
            }
        )
    )


@contextmanager
def _capture_logs(level: int = logging.WARNING) -> Generator[list[str], None, None]:
    """Context manager that captures log records as JSON strings."""
    captured: list[str] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(self.format(record))

    handler = _Capture()
    handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        yield captured
    finally:
        root.removeHandler(handler)


def _emit_violation_with_url(
    decision_id: str,
    violation: PolicyViolation,
    webhook_url: Optional[str],
) -> None:
    """Variant of _emit_violation with an explicit webhook_url parameter (for tests)."""
    payload = {
        "event": "policy_violation",
        "decision_id": decision_id,
        "rule": violation.rule,
        "proof_id": violation.proof_id,
        "confidence_level": violation.confidence_level,
        "reversibility_class": violation.reversibility_class,
        "threshold_stage": violation.threshold_stage,
        "threshold": violation.threshold,
    }
    logger.error(json.dumps(payload))

    if webhook_url:
        try:
            body = json.dumps(payload).encode()
            req = urllib.request.Request(
                webhook_url,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5):
                pass
        except Exception as exc:
            logger.warning(json.dumps({"event": "webhook_error", "detail": str(exc)}))


def run_with_webhook_success(decision_id: str) -> None:
    """Exercise the webhook delivery path with a successful mock response."""
    webhook_url = "https://hooks.example.com/compliance"

    mock_response = MagicMock()
    mock_response.__enter__ = lambda s: s
    mock_response.__exit__ = MagicMock(return_value=False)

    with patch("urllib.request.urlopen", return_value=mock_response) as mock_open:
        client = build_mock_client(decision_id)
        check = client.get_policy_check(decision_id)
        if not check.policy_compliant:
            for v in check.policy_violations:
                _emit_violation_with_url(decision_id, v, webhook_url)

        mock_open.assert_called_once()
        call_args = mock_open.call_args[0][0]
        assert isinstance(call_args, urllib.request.Request), (
            "urlopen must receive a Request object"
        )
        body = json.loads(call_args.data.decode())
        assert body["event"] == "policy_violation", "Webhook payload must include event"
        assert body["decision_id"] == decision_id, "Webhook payload must include decision_id"

    print(json.dumps({"result": "ok", "webhook": "delivery_success"}))


def run_with_webhook_failure(decision_id: str) -> None:
    """Verify that a failed webhook call logs a warning but does not re-raise."""
    webhook_url = "https://hooks.example.com/compliance"

    with _capture_logs() as logs:
        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            client = build_mock_client(decision_id)
            check = client.get_policy_check(decision_id)
            if not check.policy_compliant:
                for v in check.policy_violations:
                    _emit_violation_with_url(decision_id, v, webhook_url)  # must NOT raise

    warning_events = [json.loads(line) for line in logs if "webhook_error" in line]
    assert warning_events, "A webhook_error warning must be logged on delivery failure"
    assert "connection refused" in warning_events[0]["detail"], (
        "webhook_error detail must include the original exception message"
    )

    print(json.dumps({"result": "ok", "webhook": "failure_logged_not_raised"}))


def _build_mock_client_for_tool(decision_id: str, compliant: bool) -> MagicMock:
    """Return a mock client wired for XProofCrewCertifyTool / xproof_certify_decision."""
    from xproof.models import PolicyCheckResult

    cert = MagicMock()
    cert.transaction_hash = "tx-mvx-crew-demo"

    policy_check = PolicyCheckResult.from_dict(
        {
            "decision_id": decision_id,
            "total_anchors": 1,
            "policy_compliant": compliant,
            "policy_violations": []
            if compliant
            else [
                {
                    "rule": "irreversible-above-threshold",
                    "severity": "error",
                    "message": "Irreversible action at 0.97 exceeds the 0.90 threshold.",
                }
            ],
            "checked_at": "2026-04-22T09:00:00Z",
        }
    )

    mock = MagicMock()
    mock.certify_with_confidence.return_value = cert
    mock.get_policy_check.return_value = policy_check
    return mock


def run_crewai_certification(decision_id: str) -> None:
    """Demonstrate XProofCrewCertifyTool in a crew context.

    In a live CrewAI pipeline the tool is added to an agent's tool list and
    the LLM invokes it directly::

        from xproof.integrations.crewai import XProofNativeCrewCertifyTool
        from crewai import Agent, Crew, Task

        certify_tool = XProofNativeCrewCertifyTool(
            api_key="pm_...", author="data-hygiene-agent"
        )
        agent = Agent(
            role="Data Hygiene Specialist",
            goal="Delete PII records in compliance with GDPR policy",
            tools=[certify_tool],
        )
        task = Task(description="Delete eu-region PII records", agent=agent)
        crew = Crew(agents=[agent], tasks=[task])
        crew.kickoff()

    ``XProofNativeCrewCertifyTool`` (shown above) is the native CrewAI
    ``BaseTool`` subclass — it wraps :class:`XProofCrewCertifyTool`, the plain
    Python variant that works without the ``crewai`` package.  Both run the
    same certification loop; use ``XProofNativeCrewCertifyTool`` when adding
    the tool to a CrewAI agent's ``tools`` list, and ``XProofCrewCertifyTool``
    when calling it directly from your own code.

    Here we use :class:`XProofCrewCertifyTool` with a mocked client so the
    example remains self-contained and network-free.
    """
    import json as _json

    from xproof.exceptions import PolicyViolationError
    from xproof.integrations.crewai import XProofCrewCertifyTool

    decision_text = _json.dumps(
        {"action": "delete_pii_records", "scope": "eu-region", "count": 15_000}
    )
    # This is a sanitized declared decision basis, never private step-by-step
    # reasoning or internal chain-of-thought.

    compliant_client = _build_mock_client_for_tool(decision_id + "-ok", compliant=True)
    tool_ok = XProofCrewCertifyTool(client=compliant_client, author="data-hygiene-agent")
    tx = tool_ok.run(
        decision_text=decision_text,
        confidence_level=0.97,
        threshold_stage="pre-commitment",
        decision_id=decision_id + "-ok",
        reversibility_class="irreversible",
        why="gdpr-retention-cleanup",
    )
    assert tx == "tx-mvx-crew-demo", "Expected transaction hash from certified call"
    print(json.dumps({"result": "ok", "tool": "XProofCrewCertifyTool", "tx": tx}))

    blocked_client = _build_mock_client_for_tool(decision_id + "-blocked", compliant=False)
    tool_blocked = XProofCrewCertifyTool(client=blocked_client, author="data-hygiene-agent")
    try:
        tool_blocked.run(
            decision_text=decision_text,
            confidence_level=0.97,
            threshold_stage="pre-commitment",
            decision_id=decision_id + "-blocked",
            reversibility_class="irreversible",
            why="gdpr-retention-cleanup",
        )
        raise AssertionError("Expected PolicyViolationError was not raised")
    except PolicyViolationError as exc:
        assert exc.violations, "PolicyViolationError must carry at least one violation"
        v = exc.violations[0]
        print(
            json.dumps(
                {
                    "result": "blocked",
                    "tool": "XProofCrewCertifyTool",
                    "rule": v.rule,
                    "proof_id": v.proof_id,
                    "confidence_level": v.confidence_level,
                    "threshold": v.threshold,
                }
            )
        )


def run_autogen_certification(decision_id: str) -> None:
    """Demonstrate xproof_certify_decision registered as an AutoGen function tool.

    In a live AutoGen pipeline the function is registered on agents like this::

        assistant.register_for_llm(
            name="xproof_certify_decision",
            description="Certify a decision on-chain and gate on the compliance policy.",
        )(xproof_certify_decision)

        user_proxy.register_for_execution(
            name="xproof_certify_decision",
        )(xproof_certify_decision)

    Here we call the function directly with a mocked client to keep the
    example self-contained and network-free.  The delete-records scenario is
    identical to the CrewAI section above so both integrations are directly
    comparable.
    """
    import json as _json

    from xproof.exceptions import PolicyViolationError
    from xproof.integrations.autogen import xproof_certify_decision

    decision_text = _json.dumps(
        {"action": "delete_pii_records", "scope": "eu-region", "count": 15_000}
    )
    # This is a sanitized declared decision basis, never private step-by-step
    # reasoning or internal chain-of-thought.

    compliant_client = _build_mock_client_for_tool(decision_id + "-ok", compliant=True)
    tx = xproof_certify_decision(
        decision_text=decision_text,
        confidence_level=0.97,
        threshold_stage="pre-commitment",
        decision_id=decision_id + "-ok",
        reversibility_class="irreversible",
        why="gdpr-retention-cleanup",
        author="data-hygiene-agent",
        client=compliant_client,
    )
    assert tx == "tx-mvx-crew-demo"
    print(json.dumps({"result": "ok", "tool": "xproof_certify_decision", "tx": tx}))

    blocked_client = _build_mock_client_for_tool(decision_id + "-blocked", compliant=False)
    try:
        xproof_certify_decision(
            decision_text=decision_text,
            confidence_level=0.97,
            threshold_stage="pre-commitment",
            decision_id=decision_id + "-blocked",
            reversibility_class="irreversible",
            why="gdpr-retention-cleanup",
            author="data-hygiene-agent",
            client=blocked_client,
        )
        raise AssertionError("Expected PolicyViolationError was not raised")
    except PolicyViolationError as exc:
        assert exc.violations
        v = exc.violations[0]
        print(
            json.dumps(
                {
                    "result": "blocked",
                    "tool": "xproof_certify_decision",
                    "rule": v.rule,
                    "proof_id": v.proof_id,
                    "confidence_level": v.confidence_level,
                    "threshold": v.threshold,
                }
            )
        )


def main() -> None:
    decision_id = "demo-decision-42"

    print(f"Running compliance observability example for decision '{decision_id}' ...\n")

    print("1/5 — Core observability pattern (no webhook)")
    run(decision_id)

    print("2/5 — Webhook delivery: success path")
    run_with_webhook_success(decision_id)

    print("3/5 — Webhook delivery: failure path (must log warning, not raise)")
    run_with_webhook_failure(decision_id)

    print("4/5 — CrewAI: XProofCrewCertifyTool (compliant + blocked)")
    run_crewai_certification(decision_id)

    print("5/5 — AutoGen: xproof_certify_decision (compliant + blocked)")
    run_autogen_certification(decision_id)

    print("\nAll assertions passed — example exited cleanly.")


if __name__ == "__main__":
    main()
