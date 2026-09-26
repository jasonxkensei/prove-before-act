"""pytest wrapper — runs examples/langchain-chain/certify_tool_demo.py in CI.

Exercises both scenarios defined in the demo:
- Compliant path (confidence 0.97): tool.run() returns a transaction hash.
- Blocked path (confidence 0.82): PolicyViolationError is raised and carries
  the expected rule name.

The demo uses a mocked XProofClient throughout, so no API key or network
access is required.
"""

from __future__ import annotations

import importlib.util
import os
import types

import pytest

pytest.importorskip(
    "langchain_core",
    reason="langchain-core not installed; skipping LangChain certify-tool demo tests",
)


def _load_demo() -> types.ModuleType:
    """Load certify_tool_demo.py from the langchain-chain examples directory.

    The directory name contains a hyphen, which prevents normal package import.
    We use importlib to load the module directly from its file path.
    """
    sdk_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    demo_path = os.path.join(sdk_root, "examples", "langchain-chain", "certify_tool_demo.py")
    spec = importlib.util.spec_from_file_location("certify_tool_demo", demo_path)
    assert spec is not None and spec.loader is not None, (
        f"Could not load module spec from {demo_path}"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


_demo = _load_demo()


def test_compliant_scenario_succeeds() -> None:
    """Compliant path: confidence 0.97 — no error raised, deletion proceeds."""
    _demo.run_compliant_scenario("ci-test-langchain")


def test_blocked_scenario_raises_and_recovers() -> None:
    """Blocked path: confidence 0.82 — PolicyViolationError raised and handled."""
    _demo.run_blocked_scenario("ci-test-langchain")


def test_blocked_scenario_violation_rule() -> None:
    """PolicyViolationError carries the 'irreversible-above-threshold' rule."""
    import json

    from xproof.exceptions import PolicyViolationError
    from xproof.langchain_tool import XProofCertifyTool

    decision_id = "ci-test-langchain-rule-check-blocked"
    decision_text = json.dumps(
        {"action": "delete_pii_records", "scope": "eu-region", "count": 15_000}
    )

    client = _demo._build_mock_client(decision_id, compliant=False)
    tool = XProofCertifyTool(client=client, author="data-hygiene-agent")

    with pytest.raises(PolicyViolationError) as exc_info:
        tool.run(
            {
                "decision_text": decision_text,
                "confidence_level": 0.82,
                "threshold_stage": "pre-commitment",
                "decision_id": decision_id,
                "reversibility_class": "irreversible",
                "why": "gdpr-retention-cleanup",
            }
        )

    violations = exc_info.value.violations
    assert len(violations) == 1
    assert violations[0].rule == "irreversible actions require confidence_level >= 0.95"


def test_compliant_scenario_transaction_hash() -> None:
    """Compliant path: tool.run() returns the expected transaction hash."""
    import json

    from xproof.langchain_tool import XProofCertifyTool

    decision_id = "ci-test-langchain-tx-check-ok"
    decision_text = json.dumps(
        {"action": "delete_pii_records", "scope": "eu-region", "count": 15_000}
    )

    client = _demo._build_mock_client(decision_id, compliant=True)
    tool = XProofCertifyTool(client=client, author="data-hygiene-agent")

    tx_hash = tool.run(
        {
            "decision_text": decision_text,
            "confidence_level": 0.97,
            "threshold_stage": "pre-commitment",
            "decision_id": decision_id,
            "reversibility_class": "irreversible",
            "why": "gdpr-retention-cleanup",
        }
    )

    assert tx_hash == "tx-mvx-langchain-demo"
