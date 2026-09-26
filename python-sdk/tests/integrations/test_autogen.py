"""Tests for the AutoGen xProof integration."""

import hashlib
import re
from typing import Any
from unittest.mock import MagicMock

import pytest
from xproof.exceptions import PolicyViolationError
from xproof.integrations.autogen import (
    XProofAutoGenHooks,
    _extract_text,
    _hash_data,
    register_xproof_hooks,
    xproof_certify_decision,
)
from xproof.models import PolicyViolation


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.certify_hash.return_value = MagicMock(
        id="proof-ag",
        file_hash="h",
        transaction_hash="tx",
    )
    client.batch_certify.return_value = MagicMock()
    return client


@pytest.fixture
def hooks(mock_client):
    return XProofAutoGenHooks(client=mock_client, agent_name="test-agent")


class FakeAgent:
    """Minimal mock of autogen.ConversableAgent for testing."""

    def __init__(self, name: str = "fake-agent"):
        self.name = name
        self._hooks: dict = {}

    def register_hook(self, hookable_method: str, hook: Any) -> None:
        self._hooks.setdefault(hookable_method, []).append(hook)


def test_on_received_certifies(hooks, mock_client):
    result = hooks.on_received("Hello from user")

    assert result == "Hello from user"
    mock_client.certify_hash.assert_called_once()

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["author"] == "test-agent"
    assert call_kwargs["metadata"]["action_type"] == "message_received"
    assert call_kwargs["metadata"]["framework"] == "autogen"


def test_on_sent_certifies(hooks, mock_client):
    result = hooks.on_send("Reply from agent")

    assert result == "Reply from agent"
    mock_client.certify_hash.assert_called_once()

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["metadata"]["action_type"] == "message_sent"
    assert call_kwargs["metadata"]["framework"] == "autogen"


def test_on_received_dict_message(hooks, mock_client):
    msg = {"content": "structured message", "role": "user"}
    result = hooks.on_received(msg)

    assert result == msg
    mock_client.certify_hash.assert_called_once()

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    expected_hash = _hash_data({"direction": "received", "content": "structured message"})
    assert call_kwargs["file_hash"] == expected_hash


def test_on_received_returns_message_unchanged(hooks, mock_client):
    msg = {"content": "important data", "metadata": {"key": "value"}}
    result = hooks.on_received(msg)
    assert result is msg


def test_on_sent_returns_message_unchanged(hooks, mock_client):
    msg = "outgoing message"
    result = hooks.on_send(msg)
    assert result is msg


def test_received_disabled(mock_client):
    hooks = XProofAutoGenHooks(client=mock_client, agent_name="test-agent", certify_received=False)
    hooks.on_received("Hello")
    mock_client.certify_hash.assert_not_called()


def test_sent_disabled(mock_client):
    hooks = XProofAutoGenHooks(client=mock_client, agent_name="test-agent", certify_sent=False)
    hooks.on_send("Reply")
    mock_client.certify_hash.assert_not_called()


def test_4w_metadata_present(hooks, mock_client):
    hooks.on_received("test message")

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    meta = call_kwargs["metadata"]
    assert meta["who"] == "test-agent"
    assert "what" in meta
    assert "when" in meta
    assert "why" in meta
    # why carries a fixed fingerprint-only action classification only.
    assert meta["why"] == meta["action_type"]
    # No raw human-readable context/description is ever placed in metadata.
    assert "action_context" not in meta
    assert not any("Message received by" in str(v) for v in meta.values())
    assert meta["framework"] == "autogen"


def test_hash_includes_direction(hooks, mock_client):
    hooks.on_received("same text")
    recv_hash = mock_client.certify_hash.call_args.kwargs["file_hash"]
    mock_client.reset_mock()

    hooks.on_send("same text")
    send_hash = mock_client.certify_hash.call_args.kwargs["file_hash"]

    assert recv_hash != send_hash


def test_batch_mode_manual_flush(mock_client):
    hooks = XProofAutoGenHooks(client=mock_client, agent_name="test-agent", batch_mode=True)

    hooks.on_received("msg 1")
    hooks.on_send("msg 2")

    mock_client.certify_hash.assert_not_called()
    assert len(hooks._pending) == 2

    hooks.flush()
    mock_client.batch_certify.assert_called_once()
    assert len(hooks._pending) == 0


def test_batch_mode_flush_empty(mock_client):
    hooks = XProofAutoGenHooks(client=mock_client, agent_name="test-agent", batch_mode=True)
    hooks.flush()
    mock_client.batch_certify.assert_not_called()


def test_register_xproof_hooks_positional_client(mock_client):
    agent = FakeAgent(name="positional")
    hooks = register_xproof_hooks(agent, mock_client)

    assert hooks.agent_name == "positional"
    recv_hook = agent._hooks["process_last_received_message"][0]
    recv_hook("hello")
    mock_client.certify_hash.assert_called_once()


def test_register_xproof_hooks(mock_client):
    agent = FakeAgent(name="analyst")
    hooks = register_xproof_hooks(agent, client=mock_client)

    assert hooks.agent_name == "analyst"
    assert "process_last_received_message" in agent._hooks
    assert len(agent._hooks["process_last_received_message"]) == 1

    recv_hook = agent._hooks["process_last_received_message"][0]
    result = recv_hook("test input")
    assert result == "test input"
    mock_client.certify_hash.assert_called_once()


def test_register_xproof_hooks_custom_name(mock_client):
    agent = FakeAgent(name="default-name")
    hooks = register_xproof_hooks(agent, client=mock_client, agent_name="custom-name")
    assert hooks.agent_name == "custom-name"


def test_register_xproof_hooks_sends_hook(mock_client):
    agent = FakeAgent(name="sender")
    register_xproof_hooks(agent, client=mock_client)

    assert "process_message_before_send" in agent._hooks
    send_hook = agent._hooks["process_message_before_send"][0]
    result = send_hook("outgoing")
    assert result == "outgoing"

    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["metadata"]["action_type"] == "message_sent"


def test_extract_text_str():
    assert _extract_text("hello") == "hello"


def test_extract_text_dict():
    assert _extract_text({"content": "hello", "role": "user"}) == "hello"


def test_extract_text_dict_no_content():
    result = _extract_text({"role": "user"})
    assert "role" in result


def test_extract_text_other():
    assert _extract_text(42) == "42"


def test_on_send_with_extra_positional_args(hooks, mock_client):
    result = hooks.on_send("Reply", "recipient_agent", False)

    assert result == "Reply"
    mock_client.certify_hash.assert_called_once()
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["metadata"]["action_type"] == "message_sent"


def test_file_name_format(hooks, mock_client):
    hooks.on_received("test")
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["file_name"].startswith("msg-recv-test-agent-")
    assert call_kwargs["file_name"].endswith(".json")

    mock_client.reset_mock()
    hooks.on_send("test")
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    assert call_kwargs["file_name"].startswith("msg-sent-test-agent-")


# ---------------------------------------------------------------------------
# xproof_certify_decision — confidence + policy gate (#60)
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_client_cwc():
    client = MagicMock()
    client.certify_with_confidence.return_value = MagicMock(
        id="proof-ag-cwc",
        file_hash="h-ag",
        transaction_hash="tx-ag-cwc",
    )
    client.get_policy_check.return_value = MagicMock(
        policy_compliant=True,
        policy_violations=[],
    )
    return client


def test_xproof_certify_decision_returns_tx_hash(mock_client_cwc):
    result = xproof_certify_decision(
        decision_text="Execute trade at market price",
        confidence_level=0.97,
        threshold_stage="pre-commitment",
        decision_id="trade-ag-001",
        reversibility_class="irreversible",
        why="Risk threshold met",
        author="trading-agent",
        client=mock_client_cwc,
    )
    assert result == "tx-ag-cwc"


def test_xproof_certify_decision_hashes_decision_text(mock_client_cwc):
    decision_text = "My AutoGen decision"
    xproof_certify_decision(
        decision_text=decision_text,
        confidence_level=0.9,
        decision_id="ag-hash-001",
        client=mock_client_cwc,
    )
    expected_hash = hashlib.sha256(decision_text.encode()).hexdigest()
    call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
    assert call_kwargs["file_hash"] == expected_hash


def test_xproof_certify_decision_accepts_file_hash(mock_client_cwc):
    xproof_certify_decision(
        file_hash="b" * 64,
        confidence_level=0.9,
        decision_id="ag-fh-001",
        client=mock_client_cwc,
    )
    call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
    assert call_kwargs["file_hash"] == "b" * 64


def test_xproof_certify_decision_raises_without_decision_id(mock_client_cwc):
    with pytest.raises(ValueError, match="decision_id"):
        xproof_certify_decision(
            decision_text="something",
            confidence_level=0.9,
            decision_id="",
            client=mock_client_cwc,
        )


def test_xproof_certify_decision_raises_without_content(mock_client_cwc):
    with pytest.raises(ValueError):
        xproof_certify_decision(
            confidence_level=0.9,
            decision_id="ag-nocontent",
            client=mock_client_cwc,
        )


def test_xproof_certify_decision_raises_policy_violation_error(mock_client_cwc):
    mock_client_cwc.get_policy_check.return_value = MagicMock(
        policy_compliant=False,
        policy_violations=[
            PolicyViolation(
                proof_id="proof-ag-001",
                confidence_level=0.5,
                reversibility_class="irreversible",
                threshold_stage="partial",
                threshold=0.95,
                rule="confidence_below_threshold",
            )
        ],
    )
    with pytest.raises(PolicyViolationError):
        xproof_certify_decision(
            decision_text="risky action",
            confidence_level=0.5,
            decision_id="ag-viol-001",
            client=mock_client_cwc,
        )


def test_xproof_certify_decision_policy_check_called_with_decision_id(mock_client_cwc):
    xproof_certify_decision(
        decision_text="action",
        confidence_level=0.9,
        decision_id="ag-check-001",
        client=mock_client_cwc,
    )
    mock_client_cwc.get_policy_check.assert_called_once_with("ag-check-001")


def test_xproof_certify_decision_who_defaults_to_author(mock_client_cwc):
    xproof_certify_decision(
        decision_text="action",
        confidence_level=0.9,
        decision_id="ag-who-001",
        author="my-autogen-agent",
        client=mock_client_cwc,
    )
    call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
    assert call_kwargs["who"] == "my-autogen-agent"


def test_xproof_certify_decision_what_defaults_to_hash(mock_client_cwc):
    decision_text = "specific autogen decision"
    xproof_certify_decision(
        decision_text=decision_text,
        confidence_level=0.9,
        decision_id="ag-what-001",
        client=mock_client_cwc,
    )
    expected_hash = hashlib.sha256(decision_text.encode()).hexdigest()
    call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
    assert call_kwargs["what"] == expected_hash


def test_xproof_certify_decision_when_defaults_to_iso_timestamp(mock_client_cwc):
    xproof_certify_decision(
        decision_text="action",
        confidence_level=0.9,
        decision_id="ag-when-001",
        client=mock_client_cwc,
    )
    call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
    assert re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", call_kwargs["when"])


def test_xproof_certify_decision_reversibility_class_passed_through(mock_client_cwc):
    xproof_certify_decision(
        decision_text="action",
        confidence_level=0.9,
        decision_id="ag-rev-001",
        reversibility_class="costly",
        client=mock_client_cwc,
    )
    call_kwargs = mock_client_cwc.certify_with_confidence.call_args.kwargs
    assert call_kwargs["reversibility_class"] == "costly"
