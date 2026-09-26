"""Tests for the Fetch.ai uAgents xProof integration."""

import asyncio
from unittest.mock import MagicMock

import pytest
from xproof.integrations.fetchai import (
    XProofuAgentMiddleware,
    _hash_data,
    wrap_agent,
    xproof_handler,
)


@pytest.fixture
def mock_client():
    client = MagicMock()
    client.certify_hash.return_value = MagicMock(
        id="proof-fa",
        file_hash="hash-fa",
        transaction_hash="tx-fa",
    )
    client.batch_certify.return_value = MagicMock(
        certified=2,
        proof_ids=["proof-1", "proof-2"],
    )
    return client


@pytest.fixture
def middleware(mock_client):
    return XProofuAgentMiddleware(
        client=mock_client,
        agent_name="test-agent",
    )


# ---------------------------------------------------------------------------
# _CertFlag / certify_incoming property
# ---------------------------------------------------------------------------


class TestCertifyIncomingFlag:
    def test_bool_true_when_enabled(self, middleware):
        assert middleware.certify_incoming

    def test_bool_false_when_disabled(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, certify_incoming=False)
        assert not mw.certify_incoming

    def test_callable_certifies_message(self, middleware, mock_client):
        result = middleware.certify_incoming(
            message={"query": "hello"},
            sender="agent1abc",
            context="Test query",
        )
        mock_client.certify_hash.assert_called_once()
        assert result["proof_id"] == "proof-fa"
        assert result["file_hash"] == "hash-fa"
        assert result["transaction_hash"] == "tx-fa"
        assert "verify_url" in result

    def test_disabled_returns_none(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, certify_incoming=False)
        result = mw.certify_incoming(message="hi", sender="agent1")
        assert result is None
        mock_client.certify_hash.assert_not_called()


# ---------------------------------------------------------------------------
# certify_outgoing property
# ---------------------------------------------------------------------------


class TestCertifyOutgoingFlag:
    def test_bool_true_when_enabled(self, middleware):
        assert middleware.certify_outgoing

    def test_bool_false_when_disabled(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, certify_outgoing=False)
        assert not mw.certify_outgoing

    def test_callable_certifies_response(self, middleware, mock_client):
        result = middleware.certify_outgoing(
            response={"answer": "42"},
            recipient="agent1xyz",
            context="Research response",
        )
        mock_client.certify_hash.assert_called_once()
        assert result["proof_id"] == "proof-fa"

    def test_disabled_returns_none(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, certify_outgoing=False)
        result = mw.certify_outgoing(response="hi", recipient="agent1")
        assert result is None
        mock_client.certify_hash.assert_not_called()


# ---------------------------------------------------------------------------
# runtime setters for certify_incoming / certify_outgoing (#75)
# ---------------------------------------------------------------------------


class TestCertifyFlagSetters:
    def test_certify_incoming_setter_disables(self, middleware, mock_client):
        assert middleware.certify_incoming
        middleware.certify_incoming = False
        assert not middleware.certify_incoming
        result = middleware.certify_incoming(message="hi", sender="a1")
        assert result is None
        mock_client.certify_hash.assert_not_called()

    def test_certify_incoming_setter_re_enables(self, middleware, mock_client):
        middleware.certify_incoming = False
        middleware.certify_incoming = True
        assert middleware.certify_incoming
        middleware.certify_incoming(message="hi", sender="a1")
        mock_client.certify_hash.assert_called_once()

    def test_certify_outgoing_setter_disables(self, middleware, mock_client):
        assert middleware.certify_outgoing
        middleware.certify_outgoing = False
        assert not middleware.certify_outgoing
        result = middleware.certify_outgoing(response="out", recipient="a1")
        assert result is None
        mock_client.certify_hash.assert_not_called()

    def test_certify_outgoing_setter_re_enables(self, middleware, mock_client):
        middleware.certify_outgoing = False
        middleware.certify_outgoing = True
        assert middleware.certify_outgoing
        middleware.certify_outgoing(response="out", recipient="a1")
        mock_client.certify_hash.assert_called_once()

    def test_setters_coerce_to_bool(self, middleware):
        middleware.certify_incoming = 0
        assert middleware._cert_incoming is False
        middleware.certify_outgoing = 1
        assert middleware._cert_outgoing is True


# ---------------------------------------------------------------------------
# 4W metadata in incoming / outgoing
# ---------------------------------------------------------------------------


class TestMetadata:
    def test_incoming_4w_fields(self, middleware, mock_client):
        middleware.certify_incoming(message="ping", sender="agent1abc")
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
        assert meta["framework"] == "fetchai-uagents"
        assert meta["action_type"] == "message_received"

    def test_incoming_includes_sender(self, middleware, mock_client):
        middleware.certify_incoming(message="ping", sender="agent1xyz")
        call_kwargs = mock_client.certify_hash.call_args.kwargs
        assert call_kwargs["metadata"]["sender"] == "agent1xyz"

    def test_outgoing_4w_fields(self, middleware, mock_client):
        middleware.certify_outgoing(response="result", recipient="agent1abc")
        call_kwargs = mock_client.certify_hash.call_args.kwargs
        meta = call_kwargs["metadata"]
        assert meta["who"] == "test-agent"
        assert meta["framework"] == "fetchai-uagents"
        assert meta["action_type"] == "message_sent"

    def test_outgoing_includes_recipient(self, middleware, mock_client):
        middleware.certify_outgoing(response="result", recipient="agent1xyz")
        call_kwargs = mock_client.certify_hash.call_args.kwargs
        assert call_kwargs["metadata"]["recipient"] == "agent1xyz"

    def test_outgoing_confidence_level(self, middleware, mock_client):
        middleware.certify_outgoing(response="out", recipient="a1", confidence_level=0.9)
        call_kwargs = mock_client.certify_hash.call_args.kwargs
        assert call_kwargs["metadata"]["confidence_level"] == pytest.approx(0.9)

    def test_decision_id_propagated(self, middleware, mock_client):
        middleware.certify_incoming(message="msg", sender="a1", decision_id="did-123")
        call_kwargs = mock_client.certify_hash.call_args.kwargs
        assert call_kwargs["metadata"]["decision_id"] == "did-123"

    def test_incoming_file_name_contains_agent(self, middleware, mock_client):
        middleware.certify_incoming(message="hi", sender="a1")
        call_kwargs = mock_client.certify_hash.call_args.kwargs
        assert "test-agent" in call_kwargs["file_name"]
        assert call_kwargs["file_name"].startswith("incoming-")

    def test_outgoing_file_name_contains_agent(self, middleware, mock_client):
        middleware.certify_outgoing(response="out", recipient="a1")
        call_kwargs = mock_client.certify_hash.call_args.kwargs
        assert "test-agent" in call_kwargs["file_name"]
        assert call_kwargs["file_name"].startswith("outgoing-")

    def test_object_message_uses_dict(self, middleware, mock_client):
        msg = MagicMock()
        msg.__dict__ = {"text": "hello"}
        middleware.certify_incoming(message=msg, sender="a1")
        mock_client.certify_hash.assert_called_once()


# ---------------------------------------------------------------------------
# certify_action — dual-proof creation
# ---------------------------------------------------------------------------


class TestCertifyAction:
    def test_creates_two_proofs(self, middleware, mock_client):
        result = middleware.certify_action(
            action_name="price-lookup",
            inputs={"query": "BTC"},
            outputs={"price": 67000},
            why="Market data requested",
        )
        assert mock_client.certify_hash.call_count == 2
        assert "decision_id" in result
        assert "why_proof" in result
        assert "what_proof" in result

    def test_shared_decision_id(self, middleware, mock_client):
        result = middleware.certify_action(
            action_name="analysis",
            inputs={"topic": "ai"},
            outputs={"summary": "done"},
        )
        calls = mock_client.certify_hash.call_args_list
        did = result["decision_id"]
        assert calls[0].kwargs["metadata"]["decision_id"] == did
        assert calls[1].kwargs["metadata"]["decision_id"] == did

    def test_why_proof_action_type(self, middleware, mock_client):
        middleware.certify_action(
            action_name="lookup",
            inputs={"q": "x"},
            outputs={"a": "y"},
            why="Because",
        )
        first_call = mock_client.certify_hash.call_args_list[0].kwargs
        assert first_call["metadata"]["action_type"] == "decision"
        assert first_call["metadata"]["action_name"] == "lookup"

    def test_what_proof_action_type(self, middleware, mock_client):
        middleware.certify_action(
            action_name="lookup",
            inputs={"q": "x"},
            outputs={"a": "y"},
        )
        second_call = mock_client.certify_hash.call_args_list[1].kwargs
        assert second_call["metadata"]["action_type"] == "output"

    def test_confidence_level_in_why_proof(self, middleware, mock_client):
        middleware.certify_action(
            action_name="test",
            inputs={"i": 1},
            outputs={"o": 2},
            confidence_level=0.85,
        )
        first_call = mock_client.certify_hash.call_args_list[0].kwargs
        assert first_call["metadata"]["confidence_level"] == pytest.approx(0.85)

    def test_file_names_reference_action(self, middleware, mock_client):
        middleware.certify_action(
            action_name="my-action",
            inputs={"i": 1},
            outputs={"o": 2},
        )
        calls = mock_client.certify_hash.call_args_list
        assert "my-action" in calls[0].kwargs["file_name"]
        assert "my-action" in calls[1].kwargs["file_name"]

    def test_why_proof_hash_matches_inputs(self, middleware, mock_client):
        inputs = {"query": "hello"}
        middleware.certify_action(action_name="a", inputs=inputs, outputs={"r": 1})
        first_call = mock_client.certify_hash.call_args_list[0].kwargs
        assert first_call["file_hash"] == _hash_data(inputs)

    def test_what_proof_hash_matches_outputs(self, middleware, mock_client):
        outputs = {"answer": "42"}
        middleware.certify_action(action_name="a", inputs={"q": "?"}, outputs=outputs)
        second_call = mock_client.certify_hash.call_args_list[1].kwargs
        assert second_call["file_hash"] == _hash_data(outputs)

    def test_certify_action_batch_mode_queues_both(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, agent_name="batcher", batch_mode=True)
        result = mw.certify_action(
            action_name="batch-action",
            inputs={"i": 1},
            outputs={"o": 2},
            why="Batch test",
        )
        mock_client.certify_hash.assert_not_called()
        assert len(mw._pending) == 2
        assert result["why_proof"]["queued"] is True
        assert result["what_proof"]["queued"] is True


# ---------------------------------------------------------------------------
# flush — batch mode
# ---------------------------------------------------------------------------


class TestFlush:
    def test_batch_mode_queues_not_calls(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, agent_name="batcher", batch_mode=True)
        mw.certify_incoming(message="msg1", sender="a1")
        mw.certify_outgoing(response="resp1", recipient="a1")
        mock_client.certify_hash.assert_not_called()
        assert len(mw._pending) == 2

    def test_flush_sends_batch(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, agent_name="batcher", batch_mode=True)
        mw.certify_incoming(message="m", sender="a1")
        mw.certify_outgoing(response="r", recipient="a1")
        result = mw.flush()
        mock_client.batch_certify.assert_called_once()
        assert result is not None

    def test_flush_clears_pending(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, agent_name="batcher", batch_mode=True)
        mw.certify_incoming(message="m", sender="a1")
        mw.flush()
        assert len(mw._pending) == 0

    def test_flush_empty_returns_none(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, agent_name="batcher", batch_mode=True)
        result = mw.flush()
        mock_client.batch_certify.assert_not_called()
        assert result is None

    def test_batch_queued_result(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, agent_name="batcher", batch_mode=True)
        result = mw.certify_incoming(message="msg", sender="a1")
        assert result is not None
        assert result["queued"] is True


# ---------------------------------------------------------------------------
# xproof_handler decorator
# ---------------------------------------------------------------------------


class TestXproofHandler:
    def test_certifies_incoming_and_outgoing(self, middleware, mock_client):
        @xproof_handler(middleware)
        async def handler(ctx, sender, msg):
            return {"result": "done"}

        asyncio.run(handler(MagicMock(), "agent1abc", {"query": "hi"}))
        assert mock_client.certify_hash.call_count == 2

    def test_certifies_only_incoming_when_no_return(self, middleware, mock_client):
        @xproof_handler(middleware)
        async def handler(ctx, sender, msg):
            return None

        asyncio.run(handler(MagicMock(), "agent1abc", {"query": "hi"}))
        assert mock_client.certify_hash.call_count == 1

    def test_handler_result_returned(self, middleware, mock_client):
        @xproof_handler(middleware)
        async def handler(ctx, sender, msg):
            return {"answer": 42}

        result = asyncio.run(handler(MagicMock(), "sender", "msg"))
        assert result == {"answer": 42}

    def test_shared_decision_id_across_proofs(self, middleware, mock_client):
        @xproof_handler(middleware)
        async def handler(ctx, sender, msg):
            return "response"

        asyncio.run(handler(MagicMock(), "sender", "msg"))
        calls = mock_client.certify_hash.call_args_list
        did_incoming = calls[0].kwargs["metadata"]["decision_id"]
        did_outgoing = calls[1].kwargs["metadata"]["decision_id"]
        assert did_incoming == did_outgoing

    def test_custom_context_strings(self, middleware, mock_client):
        @xproof_handler(
            middleware,
            incoming_context="Query received",
            outgoing_context="Response sent",
        )
        async def handler(ctx, sender, msg):
            return "resp"

        asyncio.run(handler(MagicMock(), "sender", "msg"))
        calls = mock_client.certify_hash.call_args_list
        # why is a fixed fingerprint-only action classification. The custom
        # human-readable context strings must NOT appear anywhere in metadata.
        meta_in = calls[0].kwargs["metadata"]
        meta_out = calls[1].kwargs["metadata"]
        assert meta_in["why"] == "message_received"
        assert meta_out["why"] == "message_sent"
        assert "action_context" not in meta_in
        assert "action_context" not in meta_out
        assert not any("Query received" in str(v) for v in meta_in.values())
        assert not any("Response sent" in str(v) for v in meta_out.values())

    def test_preserves_function_name(self, middleware):
        @xproof_handler(middleware)
        async def my_handler(ctx, sender, msg):
            return None

        assert my_handler.__name__ == "my_handler"


# ---------------------------------------------------------------------------
# set_certify_incoming / set_certify_outgoing — runtime flag toggle (#75)
# ---------------------------------------------------------------------------


class TestRuntimeToggle:
    def test_disable_incoming_at_runtime(self, middleware, mock_client):
        middleware.set_certify_incoming(False)
        result = middleware.certify_incoming(message="hi", sender="a1")
        assert result is None
        mock_client.certify_hash.assert_not_called()

    def test_reenable_incoming_at_runtime(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, certify_incoming=False)
        mw.set_certify_incoming(True)
        result = mw.certify_incoming(message="hello", sender="a1")
        assert result is not None
        mock_client.certify_hash.assert_called_once()

    def test_disable_outgoing_at_runtime(self, middleware, mock_client):
        middleware.set_certify_outgoing(False)
        result = middleware.certify_outgoing(response="resp", recipient="a1")
        assert result is None
        mock_client.certify_hash.assert_not_called()

    def test_reenable_outgoing_at_runtime(self, mock_client):
        mw = XProofuAgentMiddleware(client=mock_client, certify_outgoing=False)
        mw.set_certify_outgoing(True)
        result = mw.certify_outgoing(response="result", recipient="a1")
        assert result is not None
        mock_client.certify_hash.assert_called_once()

    def test_incoming_bool_flag_updated_after_disable(self, middleware):
        assert bool(middleware.certify_incoming) is True
        middleware.set_certify_incoming(False)
        assert bool(middleware.certify_incoming) is False

    def test_outgoing_bool_flag_updated_after_disable(self, middleware):
        assert bool(middleware.certify_outgoing) is True
        middleware.set_certify_outgoing(False)
        assert bool(middleware.certify_outgoing) is False

    def test_toggle_incoming_back_and_forth(self, middleware, mock_client):
        middleware.set_certify_incoming(False)
        assert not middleware.certify_incoming
        middleware.set_certify_incoming(True)
        assert middleware.certify_incoming
        middleware.certify_incoming(message="ping", sender="a1")
        mock_client.certify_hash.assert_called_once()

    def test_toggle_outgoing_back_and_forth(self, middleware, mock_client):
        middleware.set_certify_outgoing(False)
        assert not middleware.certify_outgoing
        middleware.set_certify_outgoing(True)
        assert middleware.certify_outgoing
        middleware.certify_outgoing(response="pong", recipient="a1")
        mock_client.certify_hash.assert_called_once()


# ---------------------------------------------------------------------------
# wrap_agent — reads agent.name
# ---------------------------------------------------------------------------


class TestWrapAgent:
    def test_reads_agent_name(self, mock_client):
        agent = MagicMock()
        agent.name = "price-oracle"
        mw = wrap_agent(agent, client=mock_client)
        assert mw.agent_name == "price-oracle"

    def test_agent_name_override(self, mock_client):
        agent = MagicMock()
        agent.name = "original-agent"
        mw = wrap_agent(agent, client=mock_client, agent_name="custom-name")
        assert mw.agent_name == "custom-name"

    def test_returns_middleware_instance(self, mock_client):
        agent = MagicMock()
        agent.name = "my-agent"
        mw = wrap_agent(agent, client=mock_client)
        assert isinstance(mw, XProofuAgentMiddleware)

    def test_certify_incoming_flag_passed(self, mock_client):
        agent = MagicMock()
        agent.name = "agent"
        mw = wrap_agent(agent, client=mock_client, certify_incoming=False)
        assert not mw.certify_incoming

    def test_certify_outgoing_flag_passed(self, mock_client):
        agent = MagicMock()
        agent.name = "agent"
        mw = wrap_agent(agent, client=mock_client, certify_outgoing=False)
        assert not mw.certify_outgoing

    def test_batch_mode_passed(self, mock_client):
        agent = MagicMock()
        agent.name = "agent"
        mw = wrap_agent(agent, client=mock_client, batch_mode=True)
        assert mw.batch_mode is True

    def test_fallback_when_no_name_attr(self, mock_client):
        agent = MagicMock(spec=[])
        mw = wrap_agent(agent, client=mock_client)
        assert mw.agent_name == "uagent"
