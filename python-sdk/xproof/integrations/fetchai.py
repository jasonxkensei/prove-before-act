"""Fetch.ai uAgents integration for automatic Prove Before Act certification.

Wraps uAgent message handlers and interval tasks to anchor the 4W audit
trail (Who, What, When, Why) on MultiversX mainnet before and after every
agent action — without modifying application logic.

Quickstart::

    from uagents import Agent, Context
    from xproof.integrations.fetchai import xproof_handler, XProofuAgentMiddleware

    agent = Agent(name="research-agent", seed="my-seed")
    middleware = XProofuAgentMiddleware(api_key="pm_...", agent_name="research-agent")

    @agent.on_message(model=QueryMessage)
    @xproof_handler(middleware)
    async def handle_query(ctx: Context, sender: str, msg: QueryMessage):
        response = await do_research(msg.query)
        await ctx.send(sender, ResponseMessage(result=response))

Compatible with uAgents >= 0.9.x.
"""

import functools
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from ..client import XProofClient
from ..models import BatchResult, CertifyEntry


def _hash_data(data: Any) -> str:
    """Stable SHA-256 of any JSON-serialisable value."""
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class _CertFlag:
    """Dual-purpose object: boolean flag AND callable certification method.

    Returned by :attr:`XProofuAgentMiddleware.certify_incoming` and
    :attr:`XProofuAgentMiddleware.certify_outgoing`.  Behaves like a ``bool``
    when used in a conditional (``if middleware.certify_incoming: ...``) and
    like the original certification method when called
    (``middleware.certify_incoming(message=...)``).

    This preserves full backward-compatibility: callers that previously relied
    on the attribute being a boolean flag (before the mypy rename to
    ``_cert_incoming`` / ``_cert_outgoing``) can now inspect it correctly, and
    callers that invoke it as a method continue to work without changes.
    """

    __slots__ = ("_enabled", "_fn")

    def __init__(self, enabled: bool, fn: Callable[..., Any]) -> None:
        self._enabled = enabled
        self._fn = fn

    def __bool__(self) -> bool:
        return self._enabled

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self._fn(*args, **kwargs)

    def __repr__(self) -> str:
        return repr(self._enabled)


class XProofuAgentMiddleware:
    """Central Prove Before Act certification middleware for a uAgent.

    Instantiate once per agent, then pass it to :func:`xproof_handler`
    or call :meth:`certify_incoming` / :meth:`certify_outgoing` directly.

    Args:
        api_key: Prove Before Act API key (``pm_...``). Ignored when *client* is given.
        client: Pre-configured :class:`~xproof.client.XProofClient`.
        agent_name: Used as WHO in the 4W metadata. Defaults to ``"uagent"``.
        certify_incoming: Certify the incoming message (the WHY). Default ``True``.
        certify_outgoing: Certify the outgoing response (the WHAT). Default ``True``.
        batch_mode: Buffer certifications and flush with :meth:`flush`. Default ``False``.

    :attr:`certify_incoming` and :attr:`certify_outgoing` are properties that
    return a :class:`_CertFlag` object.  That object is both bool-like and
    callable, so the following patterns all work::

        # Inspect the runtime flag (previously broken after the mypy rename)
        if middleware.certify_incoming:
            print("incoming cert is enabled")

        # Call the method as before — unchanged API
        proof = middleware.certify_incoming(
            message={"query": "What is the BTC price?"},
            sender="agent1abcd",
            context="Market data query",
        )
        print(proof["proof_id"])
    """

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        agent_name: str = "uagent",
        certify_incoming: bool = True,
        certify_outgoing: bool = True,
        batch_mode: bool = False,
    ) -> None:
        self.client = client or XProofClient(api_key=api_key)
        self.agent_name = agent_name
        self._cert_incoming: bool = certify_incoming
        self._cert_outgoing: bool = certify_outgoing
        self.batch_mode = batch_mode
        self._pending: list[CertifyEntry] = []

    @property
    def certify_incoming(self) -> "_CertFlag":
        """Bool-like flag AND callable: certify an incoming message as WHY.

        Read as a boolean to check whether incoming certification is enabled::

            if middleware.certify_incoming:
                ...

        Call to certify a message directly::

            proof = middleware.certify_incoming(
                message=msg, sender="agent1abc", context="query received"
            )
        """
        return _CertFlag(self._cert_incoming, self._certify_incoming_impl)

    @property
    def certify_outgoing(self) -> "_CertFlag":
        """Bool-like flag AND callable: certify an outgoing response as WHAT.

        Read as a boolean to check whether outgoing certification is enabled::

            if middleware.certify_outgoing:
                ...

        Call to certify a response directly::

            proof = middleware.certify_outgoing(
                response=result, recipient="agent1abc", context="response sent"
            )
        """
        return _CertFlag(self._cert_outgoing, self._certify_outgoing_impl)

    @certify_incoming.setter  # type: ignore
    def certify_incoming(self, value: bool) -> None:
        """Enable or disable incoming certification at runtime.

        Example::

            middleware.certify_incoming = False  # pause WHY anchoring
            middleware.certify_incoming = True   # re-enable
        """
        self._cert_incoming = bool(value)

    @certify_outgoing.setter  # type: ignore
    def certify_outgoing(self, value: bool) -> None:
        """Enable or disable outgoing certification at runtime.

        Example::

            middleware.certify_outgoing = False  # pause WHAT anchoring
            middleware.certify_outgoing = True   # re-enable
        """
        self._cert_outgoing = bool(value)

    def _certify(
        self,
        file_hash: str,
        file_name: str,
        action_type: str,
        context: str,
        extra_metadata: Optional[dict[str, Any]] = None,
        decision_id: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        metadata: dict[str, Any] = {
            "who": self.agent_name,
            "what": file_hash,
            "when": _now_iso(),
            "why": context,
            "action_type": action_type,
            "framework": "fetchai-uagents",
        }
        if decision_id:
            metadata["decision_id"] = decision_id
        if extra_metadata:
            metadata.update(extra_metadata)

        entry: CertifyEntry = {
            "file_hash": file_hash,
            "file_name": file_name,
            "author": self.agent_name,
            "metadata": metadata,
        }

        if self.batch_mode:
            self._pending.append(entry)
            return {"queued": True, "file_hash": file_hash}

        cert = self.client.certify_hash(
            file_hash=file_hash,
            file_name=file_name,
            author=self.agent_name,
            metadata=metadata,
        )
        return {
            "proof_id": cert.id,
            "file_hash": cert.file_hash,
            "transaction_hash": cert.transaction_hash,
            "verify_url": f"https://provebeforeact.com/proof/{cert.id}",
        }

    def _certify_incoming_impl(
        self,
        message: Any,
        sender: str = "unknown",
        context: str = "Incoming uAgent message",
        decision_id: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        """Implementation: certify an incoming message as WHY (trigger / justification).

        Args:
            message: The incoming message object or dict.
            sender: Sender address for traceability metadata.
            context: Human-readable description of the trigger.
            decision_id: Shared ID linking this WHY to its WHAT pair.

        Returns:
            Dict with ``proof_id``, ``file_hash``, ``transaction_hash``,
            ``verify_url``; or ``None`` if *certify_incoming* is disabled.
        """
        if not self._cert_incoming:
            return None

        msg_dict = message.__dict__ if hasattr(message, "__dict__") else {"content": str(message)}
        msg_hash = _hash_data({"sender": sender, "message": msg_dict})

        return self._certify(
            file_hash=msg_hash,
            file_name=f"incoming-{self.agent_name}-{msg_hash[:8]}.json",
            action_type="message_received",
            context=context,
            extra_metadata={"sender": sender},
            decision_id=decision_id,
        )

    def _certify_outgoing_impl(
        self,
        response: Any,
        recipient: str = "unknown",
        context: str = "uAgent response",
        decision_id: Optional[str] = None,
        confidence_level: Optional[float] = None,
    ) -> Optional[dict[str, Any]]:
        """Implementation: certify an outgoing response as WHAT (the output to prove).

        Args:
            response: The response object or dict to hash and certify.
            recipient: Destination address for traceability metadata.
            context: Human-readable description of the output.
            decision_id: Shared ID linking this WHAT to its WHY pair.
            confidence_level: Optional float 0.0-1.0 (agent self-reported confidence).

        Returns:
            Dict with ``proof_id``, ``file_hash``, ``transaction_hash``,
            ``verify_url``; or ``None`` if *certify_outgoing* is disabled.
        """
        if not self._cert_outgoing:
            return None

        resp_dict = (
            response.__dict__ if hasattr(response, "__dict__") else {"content": str(response)}
        )
        resp_hash = _hash_data({"recipient": recipient, "response": resp_dict})

        extra: dict[str, Any] = {"recipient": recipient}
        if confidence_level is not None:
            extra["confidence_level"] = float(confidence_level)

        return self._certify(
            file_hash=resp_hash,
            file_name=f"outgoing-{self.agent_name}-{resp_hash[:8]}.json",
            action_type="message_sent",
            context=context,
            extra_metadata=extra,
            decision_id=decision_id,
        )

    def certify_action(
        self,
        action_name: str,
        inputs: Any,
        outputs: Any,
        why: str = "",
        confidence_level: Optional[float] = None,
    ) -> dict[str, Any]:
        """Certify a complete agent action as a WHY+WHAT pair.

        Creates two linked proofs sharing a ``decision_id`` — the canonical
        Prove Before Act dual-certification pattern for verifiable agent accountability.

        Args:
            action_name: Descriptive name of the action (used in file names).
            inputs: Input data / trigger (hashed as WHY).
            outputs: Output data / result (hashed as WHAT).
            why: Human-readable mandate or justification.
            confidence_level: Optional float 0.0-1.0.

        Returns:
            Dict with ``decision_id``, ``why_proof`` and ``what_proof`` dicts.

        Example::

            result = middleware.certify_action(
                action_name="price-lookup",
                inputs={"query": "BTC/USDT"},
                outputs={"price": 67800.0},
                why="Market price requested by trading strategy",
                confidence_level=0.95,
            )
            print(result["why_proof"]["proof_id"])
            print(result["what_proof"]["proof_id"])
        """
        decision_id = str(uuid.uuid4())
        inputs_hash = _hash_data(inputs)
        outputs_hash = _hash_data(outputs)

        why_extra: dict[str, Any] = {"action_name": action_name}
        if confidence_level is not None:
            why_extra["confidence_level"] = float(confidence_level)

        why_proof = self._certify(
            file_hash=inputs_hash,
            file_name=f"why-{action_name}-{inputs_hash[:8]}.json",
            action_type="decision",
            context=why or f"Reasoning before {action_name}",
            extra_metadata=why_extra,
            decision_id=decision_id,
        )

        what_proof = self._certify(
            file_hash=outputs_hash,
            file_name=f"what-{action_name}-{outputs_hash[:8]}.json",
            action_type="output",
            context=f"Output of {action_name}",
            extra_metadata={"action_name": action_name},
            decision_id=decision_id,
        )

        return {
            "decision_id": decision_id,
            "why_proof": why_proof,
            "what_proof": what_proof,
        }

    def set_certify_incoming(self, enabled: bool) -> None:
        """Enable or disable incoming message certification at runtime.

        This is useful for temporarily suppressing certification on known
        internal health-check or warm-up messages without reinstantiating
        the middleware.

        Args:
            enabled: ``True`` to enable, ``False`` to disable.

        Example::

            middleware.set_certify_incoming(False)   # suppress during warm-up
            middleware.set_certify_incoming(True)    # restore for production traffic
        """
        self._cert_incoming = enabled

    def set_certify_outgoing(self, enabled: bool) -> None:
        """Enable or disable outgoing response certification at runtime.

        Args:
            enabled: ``True`` to enable, ``False`` to disable.

        Example::

            middleware.set_certify_outgoing(False)   # disable before graceful shutdown
            middleware.set_certify_outgoing(True)    # re-enable
        """
        self._cert_outgoing = enabled

    def flush(self) -> Optional[BatchResult]:
        """Send all pending certifications in a single batch.

        Only relevant when *batch_mode* is ``True``.

        Returns:
            The :class:`~xproof.models.BatchResult`, or ``None`` if the queue was empty.
        """
        if not self._pending:
            return None
        result = self.client.batch_certify(self._pending)
        self._pending.clear()
        return result


def xproof_handler(
    middleware: XProofuAgentMiddleware,
    incoming_context: str = "Incoming uAgent message",
    outgoing_context: str = "uAgent response",
) -> Callable[..., Any]:
    """Decorator that wraps a uAgent ``on_message`` handler with Prove Before Act certification.

    Certifies the incoming message (WHY) before the handler runs, then
    certifies the response (WHAT) if the handler returns a value.

    Both proofs share a ``decision_id`` so the full reasoning chain is
    verifiable on-chain.

    Args:
        middleware: A configured :class:`XProofuAgentMiddleware` instance.
        incoming_context: Description attached to the WHY proof.
        outgoing_context: Description attached to the WHAT proof.

    Example::

        from uagents import Agent, Context
        from xproof.integrations.fetchai import XProofuAgentMiddleware, xproof_handler

        agent = Agent(name="research-agent", seed="test-seed")
        xp = XProofuAgentMiddleware(api_key="pm_...", agent_name="research-agent")

        @agent.on_message(model=Query)
        @xproof_handler(xp, incoming_context="Research query received")
        async def handle_query(ctx: Context, sender: str, msg: Query):
            result = await run_research(msg.topic)
            return result  # returned value is certified as WHAT
    """

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fn)
        async def wrapper(ctx: Any, sender: str, msg: Any) -> Any:
            decision_id = str(uuid.uuid4())

            middleware.certify_incoming(
                message=msg,
                sender=sender,
                context=incoming_context,
                decision_id=decision_id,
            )

            result = await fn(ctx, sender, msg)

            if result is not None:
                middleware.certify_outgoing(
                    response=result,
                    recipient=sender,
                    context=outgoing_context,
                    decision_id=decision_id,
                )

            return result

        return wrapper

    return decorator


def wrap_agent(
    agent: Any,
    api_key: str = "",
    client: Optional[XProofClient] = None,
    agent_name: Optional[str] = None,
    certify_incoming: bool = True,
    certify_outgoing: bool = True,
    batch_mode: bool = False,
) -> "XProofuAgentMiddleware":
    """Convenience function — creates middleware bound to a uAgent instance.

    Reads ``agent.name`` automatically so you don't have to specify it.

    Args:
        agent: A uAgents ``Agent`` instance.
        api_key: Prove Before Act API key. Ignored when *client* is provided.
        client: Pre-configured :class:`~xproof.client.XProofClient`.
        agent_name: Override the name used in 4W metadata.
        certify_incoming: Certify incoming messages. Default ``True``.
        certify_outgoing: Certify outgoing responses. Default ``True``.
        batch_mode: Buffer certifications for batch sending. Default ``False``.

    Returns:
        A ready-to-use :class:`XProofuAgentMiddleware` instance.

    Example::

        from uagents import Agent
        from xproof.integrations.fetchai import wrap_agent

        agent = Agent(name="price-oracle", seed="secret")
        xp = wrap_agent(agent, api_key="pm_...")
    """
    name: str = str(agent_name or getattr(agent, "name", "uagent"))
    return XProofuAgentMiddleware(
        api_key=api_key,
        client=client,
        agent_name=name,
        certify_incoming=certify_incoming,
        certify_outgoing=certify_outgoing,
        batch_mode=batch_mode,
    )
