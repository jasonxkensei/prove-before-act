"""Tests for the LangChain xProof callback handler."""

import json
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

pytest.importorskip("langchain_core", reason="langchain-core not installed")

from xproof.integrations.langchain import XProofCallbackHandler
from xproof.models import BatchResult, BatchResultSummary, Certification


def _make_batch_result(*proof_ids: str) -> BatchResult:
    certs = [
        Certification(
            id=pid,
            file_name=f"{pid}.json",
            file_hash="a" * 64,
            transaction_hash=f"tx-{pid}",
            transaction_url="",
            created_at="2026-04-22T09:00:00Z",
        )
        for pid in proof_ids
    ]
    return BatchResult(
        batch_id="batch-test",
        results=certs,
        summary=BatchResultSummary(total=len(certs), created=len(certs), existing=0),
    )


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.certify_hash.return_value = MagicMock(
        id="proof-lc",
        file_hash="h",
        transaction_hash="tx",
    )
    client.batch_certify.return_value = _make_batch_result("proof-batch-1", "proof-batch-2")
    return client


@pytest.fixture
def handler(mock_client):
    return XProofCallbackHandler(client=mock_client, agent_name="test-agent")


def test_llm_end_certifies(handler, mock_client):
    run_id = uuid4()
    handler.on_llm_start(
        {"name": "gpt-4"},
        ["Hello"],
        run_id=run_id,
    )

    response = MagicMock()
    gen = MagicMock()
    gen.text = "Hi there"
    response.generations = [[gen]]

    handler.on_llm_end(response, run_id=run_id)
    mock_client.certify_hash.assert_called_once()

    call_kwargs = mock_client.certify_hash.call_args
    assert call_kwargs.kwargs["author"] == "test-agent"
    assert call_kwargs.kwargs["metadata"]["action_type"] == "llm_call"
    assert call_kwargs.kwargs["metadata"]["who"] == "test-agent"
    assert "when" in call_kwargs.kwargs["metadata"]


def test_llm_includes_prompt_hash(handler, mock_client):
    import hashlib

    run_id = uuid4()
    prompts = ["What is 2+2?"]
    handler.on_llm_start({"name": "gpt-4"}, prompts, run_id=run_id)

    response = MagicMock()
    gen = MagicMock()
    gen.text = "4"
    response.generations = [[gen]]

    handler.on_llm_end(response, run_id=run_id)
    call_kwargs = mock_client.certify_hash.call_args
    file_hash = call_kwargs.kwargs["file_hash"]
    expected_prompt_hash = hashlib.sha256(
        json.dumps(prompts, sort_keys=True, default=str).encode()
    ).hexdigest()
    expected_data_hash = hashlib.sha256(
        json.dumps(
            {"model": "gpt-4", "prompt_hash": expected_prompt_hash, "output": "4"},
            sort_keys=True,
            default=str,
        ).encode()
    ).hexdigest()
    assert file_hash == expected_data_hash


def test_tool_end_certifies(handler, mock_client):
    run_id = uuid4()
    handler.on_tool_start(
        {"name": "search"},
        "query text",
        run_id=run_id,
    )
    handler.on_tool_end("search results", run_id=run_id)
    mock_client.certify_hash.assert_called_once()

    call_kwargs = mock_client.certify_hash.call_args
    assert call_kwargs.kwargs["metadata"]["action_type"] == "tool_call"
    assert "tool-search" in call_kwargs.kwargs["file_name"]


def test_tool_includes_input_hash(handler, mock_client):
    import hashlib

    run_id = uuid4()
    tool_input = "search query"
    handler.on_tool_start({"name": "web_search"}, tool_input, run_id=run_id)
    handler.on_tool_end("result data", run_id=run_id)

    call_kwargs = mock_client.certify_hash.call_args
    file_hash = call_kwargs.kwargs["file_hash"]
    expected_input_hash = hashlib.sha256(
        json.dumps(tool_input, sort_keys=True, default=str).encode()
    ).hexdigest()
    expected_data_hash = hashlib.sha256(
        json.dumps(
            {"tool": "web_search", "input_hash": expected_input_hash, "output": "result data"},
            sort_keys=True,
            default=str,
        ).encode()
    ).hexdigest()
    assert file_hash == expected_data_hash


def test_chain_events_disabled_by_default(handler, mock_client):
    run_id = uuid4()
    handler.on_chain_start({"name": "agent"}, {"input": "hi"}, run_id=run_id)
    handler.on_chain_end({"output": "bye"}, run_id=run_id)
    mock_client.certify_hash.assert_not_called()


def test_chain_events_when_enabled(mock_client):
    handler = XProofCallbackHandler(
        client=mock_client, agent_name="test-agent", certify_chains=True
    )
    run_id = uuid4()
    handler.on_chain_start({"name": "agent"}, {"input": "hi"}, run_id=run_id)
    handler.on_chain_end({"output": "bye"}, run_id=run_id)
    mock_client.certify_hash.assert_called_once()
    call_kwargs = mock_client.certify_hash.call_args
    assert call_kwargs.kwargs["metadata"]["action_type"] == "chain_completion"


def test_llm_disabled(mock_client):
    handler = XProofCallbackHandler(client=mock_client, agent_name="test-agent", certify_llm=False)
    run_id = uuid4()
    handler.on_llm_start({"name": "gpt-4"}, ["Hello"], run_id=run_id)

    response = MagicMock()
    response.generations = [[MagicMock(text="Hi")]]
    handler.on_llm_end(response, run_id=run_id)
    mock_client.certify_hash.assert_not_called()


def test_tools_disabled(mock_client):
    handler = XProofCallbackHandler(
        client=mock_client, agent_name="test-agent", certify_tools=False
    )
    run_id = uuid4()
    handler.on_tool_start({"name": "calc"}, "1+1", run_id=run_id)
    handler.on_tool_end("2", run_id=run_id)
    mock_client.certify_hash.assert_not_called()


def test_batch_mode_manual_flush(mock_client):
    handler = XProofCallbackHandler(client=mock_client, agent_name="test-agent", batch_mode=True)

    run_id1 = uuid4()
    handler.on_tool_start({"name": "search"}, "q", run_id=run_id1)
    handler.on_tool_end("result", run_id=run_id1)

    run_id2 = uuid4()
    handler.on_tool_start({"name": "calc"}, "1+1", run_id=run_id2)
    handler.on_tool_end("2", run_id=run_id2)

    mock_client.certify_hash.assert_not_called()
    assert len(handler._pending) == 2

    results = handler.flush()
    mock_client.batch_certify.assert_called_once()
    assert len(handler._pending) == 0
    assert results is not None
    assert isinstance(results, list)
    assert len(results) == 2
    assert all(hasattr(r, "id") and hasattr(r, "file_hash") for r in results)


def test_batch_mode_auto_flush_on_root_chain_end(mock_client):
    handler = XProofCallbackHandler(client=mock_client, agent_name="test-agent", batch_mode=True)

    run_id1 = uuid4()
    handler.on_tool_start({"name": "search"}, "q", run_id=run_id1)
    handler.on_tool_end("result", run_id=run_id1)

    mock_client.certify_hash.assert_not_called()
    assert len(handler._pending) == 1

    chain_run_id = uuid4()
    handler.on_chain_start({"name": "agent"}, {"input": "hi"}, run_id=chain_run_id)
    handler.on_chain_end({"output": "bye"}, run_id=chain_run_id, parent_run_id=None)

    mock_client.batch_certify.assert_called_once()
    assert len(handler._pending) == 0


def test_batch_mode_no_flush_on_nested_chain_end(mock_client):
    handler = XProofCallbackHandler(client=mock_client, agent_name="test-agent", batch_mode=True)

    run_id1 = uuid4()
    handler.on_tool_start({"name": "search"}, "q", run_id=run_id1)
    handler.on_tool_end("result", run_id=run_id1)

    parent_id = uuid4()
    child_id = uuid4()
    handler.on_chain_start({"name": "sub"}, {"input": "x"}, run_id=child_id)
    handler.on_chain_end({"output": "y"}, run_id=child_id, parent_run_id=parent_id)

    mock_client.batch_certify.assert_not_called()
    assert len(handler._pending) == 1


def test_4w_metadata_present(handler, mock_client):
    run_id = uuid4()
    handler.on_tool_start({"name": "web_search"}, "test query", run_id=run_id)
    handler.on_tool_end("results", run_id=run_id)

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    meta = call_kwargs["metadata"]
    assert "who" in meta
    assert "what" in meta
    assert "when" in meta
    assert "why" in meta
    # why carries a fixed fingerprint-only action classification only.
    assert meta["why"] == meta["action_type"]
    # No raw human-readable context/description is ever placed in metadata.
    assert "action_context" not in meta
    assert not any("Tool invocation" in str(v) for v in meta.values())
    assert not any("web_search" in str(v) for v in meta.values())
    assert meta["framework"] == "langchain"
