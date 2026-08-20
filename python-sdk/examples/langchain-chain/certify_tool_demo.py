"""LangChain + xProof: delete-records certification demo.

Demonstrates XProofCertifyTool certifying a GDPR PII-deletion decision
end-to-end — hash → certify → policy check → gate — using a mocked client so
no real API key or network access is required.

This example mirrors the CrewAI and AutoGen scenarios in
``examples/compliance_observability.py`` so all three frameworks tell the same
story and are directly comparable.

Scenario
--------
An AI data-hygiene agent is about to delete 15 000 PII records from the
EU region.  Because the action is **irreversible**, the agent must:

1. Certify its decision with ``confidence_level >= 0.95`` before touching any
   data.
2. Gate execution on the policy check result.
3. Abort with a structured error if the policy is violated.

Run from the python-sdk directory (where the xproof package is installed):

    pip install -e .
    python examples/langchain-chain/certify_tool_demo.py

Expected output: two scenarios are shown — compliant (proceeds) and
non-compliant (blocked) — with the script exiting 0.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

# `xproof` is the legacy module name retained by the canonical prove-before-act distribution.
from xproof.exceptions import PolicyViolationError
from xproof.langchain_tool import XProofCertifyTool
from xproof.models import PolicyCheckResult


def _build_mock_client(decision_id: str, *, compliant: bool) -> MagicMock:
    """Return a mock XProofClient pre-wired for XProofCertifyTool.

    The mock satisfies the two calls ``XProofCertifyTool._run`` makes:
    ``certify_with_confidence`` and ``get_policy_check``.
    """
    cert = MagicMock()
    cert.transaction_hash = "tx-mvx-langchain-demo"

    violations = (
        []
        if compliant
        else [
            {
                "proof_id": "proof-langchain-demo-blocked",
                "confidence_level": 0.82,
                "reversibility_class": "irreversible",
                "threshold_stage": "pre-commitment",
                "threshold": 0.95,
                "rule": "irreversible actions require confidence_level >= 0.95",
            }
        ]
    )
    policy_check = PolicyCheckResult.from_dict(
        {
            "decision_id": decision_id,
            "total_anchors": 1,
            "policy_compliant": compliant,
            "policy_violations": violations,
            "checked_at": "2026-04-22T09:00:00Z",
        }
    )

    mock = MagicMock()
    mock.certify_with_confidence.return_value = cert
    mock.get_policy_check.return_value = policy_check
    return mock


def run_compliant_scenario(base_decision_id: str) -> None:
    """Scenario 1: confidence 0.97 — policy passes, deletion proceeds."""
    decision_id = base_decision_id + "-ok"
    decision_text = json.dumps(
        {"action": "delete_pii_records", "scope": "eu-region", "count": 15_000}
    )

    client = _build_mock_client(decision_id, compliant=True)
    tool = XProofCertifyTool(client=client, author="data-hygiene-agent")

    print("Scenario 1 — compliant (confidence 0.97)")
    try:
        tx_hash = tool.run(
            {
                "decision_text": decision_text,
                "confidence_level": 0.97,
                "threshold_stage": "pre-commitment",
                "decision_id": decision_id,
                "reversibility_class": "irreversible",
                "why": "Scheduled GDPR retention cleanup",
            }
        )
        print(f"  Policy compliant — proceeding (tx: {tx_hash})")
        # delete_pii_records("eu-region")   # your actual execution here
    except PolicyViolationError as exc:
        for v in exc.violations:
            print(
                f"  BLOCKED [POLICY VIOLATION] {v.rule} (proof_id={v.proof_id}, confidence_level={v.confidence_level}, threshold={v.threshold})"
            )
        raise RuntimeError("Deletion aborted: policy compliance check failed.") from exc

    print()


def run_blocked_scenario(base_decision_id: str) -> None:
    """Scenario 2: confidence 0.82 — policy violated, deletion aborted."""
    decision_id = base_decision_id + "-blocked"
    decision_text = json.dumps(
        {"action": "delete_pii_records", "scope": "eu-region", "count": 15_000}
    )

    client = _build_mock_client(decision_id, compliant=False)
    tool = XProofCertifyTool(client=client, author="data-hygiene-agent")

    print("Scenario 2 — blocked (confidence 0.82, below 0.95 threshold)")
    try:
        tool.run(
            {
                "decision_text": decision_text,
                "confidence_level": 0.82,
                "threshold_stage": "pre-commitment",
                "decision_id": decision_id,
                "reversibility_class": "irreversible",
                "why": "Scheduled GDPR retention cleanup",
            }
        )
        raise AssertionError("Expected PolicyViolationError was not raised")
    except PolicyViolationError as exc:
        for v in exc.violations:
            print(
                f"  BLOCKED [POLICY VIOLATION] {v.rule} (proof_id={v.proof_id}, confidence_level={v.confidence_level}, threshold={v.threshold})"
            )
        print("  Deletion aborted — audit trail preserved on-chain.")

    print()


def main() -> None:
    base_decision_id = "del-run-2026-04-22"

    print("=== LangChain XProofCertifyTool — delete-records demo ===")
    print()

    run_compliant_scenario(base_decision_id)
    run_blocked_scenario(base_decision_id)

    print("Both scenarios completed — script exiting 0.")


if __name__ == "__main__":
    main()
