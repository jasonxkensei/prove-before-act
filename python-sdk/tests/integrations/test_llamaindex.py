"""Tests for the LlamaIndex xProof callback handler."""

import hashlib
import json
import sys
from enum import Enum
from typing import Any
from unittest.mock import MagicMock

import pytest


class FakeCBEventType(str, Enum):
    LLM = "llm"
    QUERY = "query"
    FUNCTION_CALL = "function_call"
    EMBEDDING = "embedding"
    RETRIEVE = "retrieve"


class FakeBaseCallbackHandler:
    def __init__(self, event_starts_to_ignore=None, event_ends_to_ignore=None):
        pass

    def start_trace(self, trace_id=None):
        pass

    def end_trace(self, trace_id=None, trace_map=None):
        pass

    def on_event_start(self, event_type, payload=None, event_id="", parent_id="", **kwargs):
        return event_id

    def on_event_end(self, event_type, payload=None, event_id="", **kwargs):
        pass


fake_callbacks_base = MagicMock()
fake_callbacks_base.BaseCallbackHandler = FakeBaseCallbackHandler

fake_callbacks_schema = MagicMock()
fake_callbacks_schema.CBEventType = FakeCBEventType

sys.modules.setdefault("llama_index", MagicMock())
sys.modules.setdefault("llama_index.core", MagicMock())
sys.modules.setdefault("llama_index.core.callbacks", MagicMock())
sys.modules.setdefault("llama_index.core.callbacks.base", fake_callbacks_base)
sys.modules.setdefault("llama_index.core.callbacks.schema", fake_callbacks_schema)

from xproof.integrations.llamaindex import XProofCallbackHandler  # noqa: E402


def _hash_data(data: Any) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.certify_hash.return_value = MagicMock(
        id="proof-li",
        file_hash="h",
        transaction_hash="tx",
    )
    client.batch_certify.return_value = MagicMock()
    return client


@pytest.fixture
def handler(mock_client):
    return XProofCallbackHandler(client=mock_client, agent_name="test-agent")


def test_llm_end_certifies(handler, mock_client):
    event_id = "evt-llm-1"
    handler.on_event_start(
        FakeCBEventType.LLM,
        payload={"messages": ["Hello"]},
        event_id=event_id,
    )

    handler.on_event_end(
        FakeCBEventType.LLM,
        payload={"response": "Hi there"},
        event_id=event_id,
    )
    mock_client.certify_hash.assert_called_once()

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["author"] == "test-agent"
    assert call_kwargs["metadata"]["action_type"] == "llm_call"
    assert call_kwargs["metadata"]["who"] == "test-agent"
    assert "when" in call_kwargs["metadata"]
    assert call_kwargs["metadata"]["framework"] == "llamaindex"


def test_llm_includes_start_hash(handler, mock_client):
    event_id = "evt-llm-2"
    start_payload = {"messages": ["What is 2+2?"]}
    handler.on_event_start(
        FakeCBEventType.LLM,
        payload=start_payload,
        event_id=event_id,
    )

    handler.on_event_end(
        FakeCBEventType.LLM,
        payload={"response": "4"},
        event_id=event_id,
    )

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    file_hash = call_kwargs["file_hash"]
    expected_start_hash = _hash_data(start_payload)
    expected_data_hash = _hash_data(
        {
            "event_type": "llm",
            "start_hash": expected_start_hash,
            "output": "4",
        }
    )
    assert file_hash == expected_data_hash


def test_query_end_certifies(handler, mock_client):
    event_id = "evt-query-1"
    handler.on_event_start(
        FakeCBEventType.QUERY,
        payload={"query_str": "What is AI?"},
        event_id=event_id,
    )

    handler.on_event_end(
        FakeCBEventType.QUERY,
        payload={"response": "Artificial Intelligence is..."},
        event_id=event_id,
    )
    mock_client.certify_hash.assert_called_once()

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["metadata"]["action_type"] == "query"
    assert "query-llamaindex" in call_kwargs["file_name"]


def test_function_call_end_certifies(handler, mock_client):
    event_id = "evt-func-1"
    handler.on_event_start(
        FakeCBEventType.FUNCTION_CALL,
        payload={"tool": "calculator", "function_call": "add"},
        event_id=event_id,
    )

    handler.on_event_end(
        FakeCBEventType.FUNCTION_CALL,
        payload={
            "tool": "calculator",
            "function_call_response": "42",
        },
        event_id=event_id,
    )
    mock_client.certify_hash.assert_called_once()

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["metadata"]["action_type"] == "function_call"
    assert "tool-calculator" in call_kwargs["file_name"]


def test_function_call_includes_tool_name_in_hash(handler, mock_client):
    event_id = "evt-func-2"
    start_payload = {"tool": "web_search", "function_call": "search"}
    handler.on_event_start(
        FakeCBEventType.FUNCTION_CALL,
        payload=start_payload,
        event_id=event_id,
    )

    handler.on_event_end(
        FakeCBEventType.FUNCTION_CALL,
        payload={
            "tool": "web_search",
            "function_call_response": "search results",
        },
        event_id=event_id,
    )

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    file_hash = call_kwargs["file_hash"]
    expected_start_hash = _hash_data(start_payload)
    expected_data_hash = _hash_data(
        {
            "event_type": "function_call",
            "tool": "web_search",
            "start_hash": expected_start_hash,
            "output": "search results",
        }
    )
    assert file_hash == expected_data_hash


def test_llm_disabled(mock_client):
    handler = XProofCallbackHandler(client=mock_client, agent_name="test-agent", certify_llm=False)
    event_id = "evt-llm-off"
    handler.on_event_start(
        FakeCBEventType.LLM,
        payload={"messages": ["Hello"]},
        event_id=event_id,
    )
    handler.on_event_end(
        FakeCBEventType.LLM,
        payload={"response": "Hi"},
        event_id=event_id,
    )
    mock_client.certify_hash.assert_not_called()


def test_query_disabled(mock_client):
    handler = XProofCallbackHandler(
        client=mock_client, agent_name="test-agent", certify_query=False
    )
    event_id = "evt-query-off"
    handler.on_event_start(
        FakeCBEventType.QUERY,
        payload={"query_str": "test"},
        event_id=event_id,
    )
    handler.on_event_end(
        FakeCBEventType.QUERY,
        payload={"response": "result"},
        event_id=event_id,
    )
    mock_client.certify_hash.assert_not_called()


def test_function_call_disabled(mock_client):
    handler = XProofCallbackHandler(
        client=mock_client, agent_name="test-agent", certify_function_call=False
    )
    event_id = "evt-func-off"
    handler.on_event_start(
        FakeCBEventType.FUNCTION_CALL,
        payload={"tool": "calc"},
        event_id=event_id,
    )
    handler.on_event_end(
        FakeCBEventType.FUNCTION_CALL,
        payload={"function_call_response": "2"},
        event_id=event_id,
    )
    mock_client.certify_hash.assert_not_called()


def test_untracked_event_ignored(handler, mock_client):
    event_id = "evt-embed"
    handler.on_event_start(
        FakeCBEventType.EMBEDDING,
        payload={"text": "hello"},
        event_id=event_id,
    )
    handler.on_event_end(
        FakeCBEventType.EMBEDDING,
        payload={"embedding": [0.1, 0.2]},
        event_id=event_id,
    )
    mock_client.certify_hash.assert_not_called()


def test_batch_mode_manual_flush(mock_client):
    handler = XProofCallbackHandler(client=mock_client, agent_name="test-agent", batch_mode=True)

    event_id1 = "evt-batch-1"
    handler.on_event_start(
        FakeCBEventType.LLM,
        payload={"messages": ["q1"]},
        event_id=event_id1,
    )
    handler.on_event_end(
        FakeCBEventType.LLM,
        payload={"response": "a1"},
        event_id=event_id1,
    )

    event_id2 = "evt-batch-2"
    handler.on_event_start(
        FakeCBEventType.LLM,
        payload={"messages": ["q2"]},
        event_id=event_id2,
    )
    handler.on_event_end(
        FakeCBEventType.LLM,
        payload={"response": "a2"},
        event_id=event_id2,
    )

    mock_client.certify_hash.assert_not_called()
    assert len(handler._pending) == 2

    handler.flush()
    mock_client.batch_certify.assert_called_once()
    assert len(handler._pending) == 0


def test_batch_mode_auto_flush_on_end_trace(mock_client):
    handler = XProofCallbackHandler(client=mock_client, agent_name="test-agent", batch_mode=True)

    event_id = "evt-auto-flush"
    handler.on_event_start(
        FakeCBEventType.LLM,
        payload={"messages": ["q"]},
        event_id=event_id,
    )
    handler.on_event_end(
        FakeCBEventType.LLM,
        payload={"response": "a"},
        event_id=event_id,
    )

    mock_client.certify_hash.assert_not_called()
    assert len(handler._pending) == 1

    handler.end_trace(trace_id="trace-1")
    mock_client.batch_certify.assert_called_once()
    assert len(handler._pending) == 0


def test_4w_metadata_present(handler, mock_client):
    event_id = "evt-4w"
    handler.on_event_start(
        FakeCBEventType.FUNCTION_CALL,
        payload={"tool": "web_search"},
        event_id=event_id,
    )
    handler.on_event_end(
        FakeCBEventType.FUNCTION_CALL,
        payload={"tool": "web_search", "function_call_response": "results"},
        event_id=event_id,
    )

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
    assert meta["framework"] == "llamaindex"


def test_event_id_in_metadata(handler, mock_client):
    event_id = "evt-id-check"
    handler.on_event_start(
        FakeCBEventType.LLM,
        payload={"messages": ["test"]},
        event_id=event_id,
    )
    handler.on_event_end(
        FakeCBEventType.LLM,
        payload={"response": "ok"},
        event_id=event_id,
    )

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["metadata"]["event_id"] == event_id
