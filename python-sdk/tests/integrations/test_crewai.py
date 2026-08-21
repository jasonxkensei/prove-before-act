"""Tests for the CrewAI xProof integration."""

import hashlib
import json
from unittest.mock import MagicMock

import pytest
from xproof.exceptions import PolicyViolationError
from xproof.integrations.crewai import (
    XProofCrewCallback,
    XProofCrewCertifyTool,
    XProofTool,
    _hash_data,
)
from xproof.models import PolicyViolation


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.certify_hash.return_value = MagicMock(
        id="proof-crew",
        file_hash="h",
        transaction_hash="tx-crew",
    )
    return client


@pytest.fixture
def mock_client_cwc():
    client = MagicMock()
    client.certify_with_confidence.return_value = MagicMock(
        id="proof-cwc",
        file_hash="h-cwc",
        transaction_hash="tx-cwc",
    )
    client.get_policy_check.return_value = MagicMock(
        policy_compliant=True,
        policy_violations=[],
    )
    return client


class TestXProofTool:
    def test_certifies_text_input(self, mock_client):
        tool = XProofTool(client=mock_client, agent_name="researcher")
        result = tool._run("This is my research output")
        mock_client.certify_hash.assert_called_once()

        call_kwargs = mock_client.certify_hash.call_args.kwargs
        assert call_kwargs["author"] == "researcher"
        assert call_kwargs["who"] == "researcher"

        parsed = json.loads(result)
        assert parsed["status"] == "certified"
        assert parsed["proof_id"] == "proof-crew"

    def test_certifies_json_input(self, mock_client):
        tool = XProofTool(client=mock_client, agent_name="writer")
        input_data = json.dumps(
            {
                "content": "Article draft",
                "file_name": "article.md",
            }
        )
        tool._run(input_data)

        call_kwargs = mock_client.certify_hash.call_args.kwargs
        assert call_kwargs["file_name"] == "article.md"


class TestXProofCrewCallback:
    def test_task_complete(self, mock_client):
        cb = XProofCrewCallback(client=mock_client, crew_name="test-crew")
        result = cb.on_task_complete(
            agent_role="researcher",
            task_description="Research market trends",
            output="Market analysis: ...",
        )

        mock_client.certify_hash.assert_called_once()
        call_kwargs = mock_client.certify_hash.call_args.kwargs

        assert call_kwargs["author"] == "researcher"
        assert call_kwargs["who"] == "researcher"
        # why is a fixed fingerprint-only action classification.
        assert call_kwargs["why"] == "task_completion"
        meta = call_kwargs["metadata"]
        # The raw task description is NEVER stored as plaintext; only its hash.
        assert "task_description" not in meta
        assert meta["task_description_hash"] == _hash_data("Research market trends")
        assert not any("Research market trends" in str(v) for v in meta.values())
        assert meta["framework"] == "crewai"
        assert meta["crew_name"] == "test-crew"

        assert result["agent_role"] == "researcher"
        assert result["proof_id"] == "proof-crew"
        assert len(cb.certifications) == 1

    def test_crew_complete(self, mock_client):
        cb = XProofCrewCallback(client=mock_client, crew_name="analysis-crew")

        cb.on_task_complete("researcher", "Research", "findings")
        cb.on_task_complete("writer", "Write report", "report text")

        assert len(cb.certifications) == 2

        result = cb.on_crew_complete(
            crew_name="analysis-crew",
            goal="Produce quarterly analysis",
            results={"summary": "Q1 looks good"},
        )

        assert mock_client.certify_hash.call_count == 3
        last_call = mock_client.certify_hash.call_args.kwargs
        assert last_call["who"] == "analysis-crew"
        # why is a fixed fingerprint-only action classification.
        assert last_call["why"] == "crew_completion"
        last_meta = last_call["metadata"]
        # The raw goal is NEVER stored as plaintext; only its hash.
        assert "goal" not in last_meta
        assert last_meta["goal_hash"] == _hash_data("Produce quarterly analysis")
        assert not any("Produce quarterly analysis" in str(v) for v in last_meta.values())
        assert last_meta["task_count"] == 2

        assert result["tasks_certified"] == 2
        assert result["crew_name"] == "analysis-crew"

    def test_4w_metadata(self, mock_client):
        cb = XProofCrewCallback(client=mock_client, crew_name="test-crew")
        cb.on_task_complete("agent-x", "Do thing", "output")

        call_kwargs = mock_client.certify_hash.call_args.kwargs
        assert "who" in call_kwargs
        assert "what" in call_kwargs
        assert "when" in call_kwargs
        assert "why" in call_kwargs
        assert call_kwargs["metadata"]["agent_role"] == "agent-x"

    def test_task_output_hash_matches_what(self, mock_client):
        import hashlib

        cb = XProofCrewCallback(client=mock_client, crew_name="test-crew")
        output = "My research findings"
        cb.on_task_complete("researcher", "Research task", output)

        call_kwargs = mock_client.certify_hash.call_args.kwargs
        expected_hash = hashlib.sha256(
            json.dumps(output, sort_keys=True, default=str).encode()
        ).hexdigest()
        assert call_kwargs["file_hash"] == expected_hash
        assert call_kwargs["what"] == expected_hash

    def test_crew_complete_includes_task_proof_ids(self, mock_client):
        cb = XProofCrewCallback(client=mock_client, crew_name="audit-crew")
        cb.on_task_complete("agent-a", "Task A", "output-a")
        cb.on_task_complete("agent-b", "Task B", "output-b")

        result = cb.on_crew_complete("audit-crew", "Full audit", {"done": True})
        last_call = mock_client.certify_hash.call_args.kwargs
        assert last_call["metadata"]["task_proof_ids"] == ["proof-crew", "proof-crew"]
        assert last_call["metadata"]["task_count"] == 2
        assert result["tasks_certified"] == 2


# ---------------------------------------------------------------------------
# XProofCrewCertifyTool — confidence + policy gate (#60)
# ---------------------------------------------------------------------------


class TestXProofCrewCertifyTool:
    def test_run_returns_transaction_hash(self, mock_client_cwc):
        tool = XProofCrewCertifyTool(client=mock_client_cwc, author="data-agent")
        result = tool.run(
            decision_text="Delete inactive records",
            confidence_level=0.97,
            threshold_stage="pre-commitment",
            decision_id="del-run-001",
            reversibility_class="irreversible",
        )
        assert result == "tx-cwc"

    def test_run_hashes_decision_text(self, mock_client_cwc):
        tool = XProofCrewCertifyTool(client=mock_client_cwc)
        decision_text = "My agent decision"
        tool.run(
            decision_text=decision_text,
            confidence_level=0.9,
            decision_id="d-hash-001",
        )
        expected_hash = hashlib.sha256(decision_text.encode()).hexdigest()
        call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
        assert call_kwargs["file_hash"] == expected_hash

    def test_run_accepts_precomputed_file_hash(self, mock_client_cwc):
        tool = XProofCrewCertifyTool(client=mock_client_cwc)
        tool.run(
            file_hash="a" * 64,
            confidence_level=0.9,
            decision_id="d-fh-001",
        )
        call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
        assert call_kwargs["file_hash"] == "a" * 64

    def test_raises_value_error_without_decision_id(self, mock_client_cwc):
        tool = XProofCrewCertifyTool(client=mock_client_cwc)
        with pytest.raises(ValueError, match="decision_id"):
            tool.run(decision_text="something", confidence_level=0.9, decision_id="")

    def test_raises_value_error_without_content(self, mock_client_cwc):
        tool = XProofCrewCertifyTool(client=mock_client_cwc)
        with pytest.raises(ValueError):
            tool.run(confidence_level=0.9, decision_id="d-nocontent")

    def test_policy_violation_raises_policy_violation_error(self, mock_client_cwc):
        mock_client_cwc.get_policy_check.return_value = MagicMock(
            policy_compliant=False,
            policy_violations=[
                PolicyViolation(
                    proof_id="proof-crew-001",
                    confidence_level=0.5,
                    reversibility_class="irreversible",
                    threshold_stage="partial",
                    threshold=0.95,
                    rule="confidence_below_threshold",
                )
            ],
        )
        tool = XProofCrewCertifyTool(client=mock_client_cwc)
        with pytest.raises(PolicyViolationError):
            tool.run(decision_text="risky", confidence_level=0.5, decision_id="d-viol-001")

    def test_policy_check_called_with_decision_id(self, mock_client_cwc):
        tool = XProofCrewCertifyTool(client=mock_client_cwc)
        tool.run(decision_text="action", confidence_level=0.9, decision_id="d-check-001")
        mock_client_cwc.get_policy_check.assert_called_once_with("d-check-001")

    def test_reversibility_class_passed_through(self, mock_client_cwc):
        tool = XProofCrewCertifyTool(client=mock_client_cwc)
        tool.run(
            decision_text="action",
            confidence_level=0.9,
            decision_id="d-rev-001",
            reversibility_class="reversible",
        )
        call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
        assert call_kwargs["reversibility_class"] == "reversible"

    def test_who_defaults_to_author(self, mock_client_cwc):
        tool = XProofCrewCertifyTool(client=mock_client_cwc, author="my-crew-agent")
        tool.run(decision_text="action", confidence_level=0.9, decision_id="d-who-001")
        call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
        assert call_kwargs["who"] == "my-crew-agent"

    def test_what_defaults_to_hash(self, mock_client_cwc):
        tool = XProofCrewCertifyTool(client=mock_client_cwc)
        decision_text = "specific decision"
        tool.run(decision_text=decision_text, confidence_level=0.9, decision_id="d-what-001")
        expected_hash = hashlib.sha256(decision_text.encode()).hexdigest()
        call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
        assert call_kwargs["what"] == expected_hash

    def test_when_defaults_to_iso_timestamp(self, mock_client_cwc):
        import re

        tool = XProofCrewCertifyTool(client=mock_client_cwc)
        tool.run(decision_text="action", confidence_level=0.9, decision_id="d-when-001")
        call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
        assert re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", call_kwargs["when"])
