"""Tests for the DeerFlow xProof skill integration."""

import json
from unittest.mock import MagicMock

import pytest
from xproof.integrations.deerflow import XProofDeerFlowSkill, _hash_data


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.certify_hash.return_value = MagicMock(
        id="proof-df",
        file_hash="h",
        transaction_hash="tx-df",
    )
    return client


@pytest.fixture
def skill(mock_client):
    return XProofDeerFlowSkill(client=mock_client, agent_name="test-agent")


def test_certifies_plain_text(skill, mock_client):
    result = skill._run("My research findings")
    mock_client.certify_hash.assert_called_once()

    parsed = json.loads(result)
    assert parsed["status"] == "certified"
    assert parsed["proof_id"] == "proof-df"
    assert parsed["file_hash"] == "h"
    assert parsed["transaction_hash"] == "tx-df"


def test_certifies_json_input(skill, mock_client):
    input_data = json.dumps(
        {
            "content": "Analysis report",
            "file_name": "report.md",
            "author": "analyst",
            "why": "quarterly_review",
        }
    )
    skill._run(input_data)

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["file_name"] == "report.md"
    assert call_kwargs["author"] == "analyst"
    assert call_kwargs["metadata"]["who"] == "analyst"
    assert call_kwargs["metadata"]["why"] == "quarterly_review"


def test_default_file_name(skill, mock_client):
    skill._run("some content")
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["file_name"] == "deerflow-output.json"


def test_default_author(skill, mock_client):
    skill._run("some content")
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["author"] == "test-agent"
    assert call_kwargs["metadata"]["who"] == "test-agent"


def test_default_why(skill, mock_client):
    skill._run("some content")
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    # why defaults to a fixed fingerprint-only action classification.
    assert call_kwargs["metadata"]["why"] == "skill_certification"


def test_4w_metadata_present(skill, mock_client):
    skill._run("test content")
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    meta = call_kwargs["metadata"]
    assert "who" in meta
    assert "what" in meta
    assert "when" in meta
    assert "why" in meta
    assert meta["framework"] == "deerflow"
    assert meta["action_type"] == "skill_certification"


def test_hash_matches_content(skill, mock_client):
    content = "Certify this text"
    skill._run(content)
    call_kwargs = mock_client.certify_hash.call_args.kwargs

    expected_hash = _hash_data(content)
    assert call_kwargs["file_hash"] == expected_hash
    assert call_kwargs["metadata"]["what"] == expected_hash


def test_json_result_structure(skill, mock_client):
    result = skill._run("test")
    parsed = json.loads(result)
    assert set(parsed.keys()) == {"proof_id", "file_hash", "transaction_hash", "status"}


def test_skill_name_and_description(skill):
    assert skill.name == "xproof_certify"
    assert "certify" in skill.description.lower()
    assert "blockchain" in skill.description.lower()


def test_author_override_in_json(skill, mock_client):
    input_data = json.dumps(
        {
            "content": "output text",
            "author": "custom-agent",
        }
    )
    skill._run(input_data)
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["author"] == "custom-agent"
    assert call_kwargs["metadata"]["who"] == "custom-agent"


def test_content_fallback_for_missing_key(skill, mock_client):
    input_data = json.dumps({"file_name": "test.json"})
    skill._run(input_data)
    mock_client.certify_hash.assert_called_once()


def test_dict_input(skill, mock_client):
    result = skill._run(
        {
            "content": "Dict-based input",
            "file_name": "dict-test.json",
            "author": "dict-agent",
            "why": "dict_input_test",
        }
    )
    mock_client.certify_hash.assert_called_once()

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["file_name"] == "dict-test.json"
    assert call_kwargs["author"] == "dict-agent"
    assert call_kwargs["metadata"]["who"] == "dict-agent"
    assert call_kwargs["metadata"]["why"] == "dict_input_test"

    parsed = json.loads(result)
    assert parsed["status"] == "certified"
