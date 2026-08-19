"""AutoGen integration for automatic Prove Before Act certification.

Provides hook helpers and an optional ConversableAgent subclass that
auto-certify messages exchanged between AutoGen agents on-chain using
the Prove Before Act 4W framework (Who, What, When, Why).

Targets AutoGen 0.2.x (pyautogen). AutoGen 0.4.x event-driven
architecture is out of scope.
"""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional, cast

from ..client import XProofClient
from ..exceptions import PolicyViolationError
from ..models import CertifyEntry, ReversibilityClass


def _hash_data(data: Any) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


def _extract_text(message: Any) -> str:
    """Extract text content from an AutoGen message.

    AutoGen messages can be strings, dicts with a ``content`` key, or
    other structures.  This helper normalises them to a plain string.
    """
    if isinstance(message, str):
        return message
    if isinstance(message, dict):
        return str(message.get("content", message))
    return str(message)


class XProofAutoGenHooks:
    """Manages Prove Before Act certification hooks for an AutoGen agent.

    Use :func:`register_xproof_hooks` for a one-liner setup, or
    instantiate this class directly for more control.

    Example::

        from xproof.integrations.autogen import XProofAutoGenHooks

        hooks = XProofAutoGenHooks(api_key="pm_...")
        agent.register_hook("process_last_received_message", hooks.on_received)

    """

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        agent_name: str = "autogen-agent",
        certify_received: bool = True,
        certify_sent: bool = True,
        batch_mode: bool = False,
    ) -> None:
        self.client = client or XProofClient(api_key=api_key)
        self.agent_name = agent_name
        self.certify_received = certify_received
        self.certify_sent = certify_sent
        self.batch_mode = batch_mode
        self._pending: list[CertifyEntry] = []

    def _certify(
        self,
        action_type: str,
        data_hash: str,
        file_name: str,
        context: str = "",
    ) -> None:
        entry: CertifyEntry = {
            "file_hash": data_hash,
            "file_name": file_name,
            "author": self.agent_name,
            "metadata": {
                "who": self.agent_name,
                "what": data_hash,
                "when": datetime.now(timezone.utc).isoformat(),
                "why": context or action_type,
                "action_type": action_type,
                "framework": "autogen",
            },
        }

        if self.batch_mode:
            self._pending.append(entry)
        else:
            self.client.certify_hash(
                file_hash=entry["file_hash"],
                file_name=entry["file_name"],
                author=entry["author"],
                metadata=entry["metadata"],
            )

    def flush(self) -> None:
        """Send all pending certifications in a batch."""
        if not self._pending:
            return
        self.client.batch_certify(self._pending)
        self._pending.clear()

    def on_received(self, message: Any) -> Any:
        """Hook for ``process_last_received_message``.

        Certifies the incoming message content and returns it unchanged
        so the agent can continue processing.
        """
        if self.certify_received:
            text = _extract_text(message)
            data_hash = _hash_data({"direction": "received", "content": text})
            self._certify(
                action_type="message_received",
                data_hash=data_hash,
                file_name=f"msg-recv-{self.agent_name}-{data_hash[:8]}.json",
                context=f"Message received by {self.agent_name}",
            )
        return message

    def on_send(self, message: Any, *args: Any, **kwargs: Any) -> Any:
        """Hook for ``process_message_before_send``.

        Certifies the outgoing message content and returns it unchanged.
        Accepts extra positional args (``recipient``, ``silent``) that
        newer pyautogen releases pass to the hook callback.
        """
        if self.certify_sent:
            text = _extract_text(message)
            data_hash = _hash_data({"direction": "sent", "content": text})
            self._certify(
                action_type="message_sent",
                data_hash=data_hash,
                file_name=f"msg-sent-{self.agent_name}-{data_hash[:8]}.json",
                context=f"Message sent by {self.agent_name}",
            )
        return message


def register_xproof_hooks(
    agent: Any,
    client: Optional[XProofClient] = None,
    api_key: str = "",
    agent_name: Optional[str] = None,
    certify_received: bool = True,
    certify_sent: bool = True,
    batch_mode: bool = False,
) -> "XProofAutoGenHooks":
    """Register Prove Before Act certification hooks on an AutoGen agent.

    This is the recommended one-liner for adding Prove Before Act certification to
    any ``ConversableAgent`` (or subclass such as ``AssistantAgent`` or
    ``UserProxyAgent``).

    Args:
        agent: An AutoGen ``ConversableAgent`` instance.
        api_key: Prove Before Act API key (ignored if *client* is provided).
        client: Pre-configured :class:`~xproof.client.XProofClient`.
        agent_name: Name used in 4W metadata. Defaults to ``agent.name``.
        certify_received: Certify incoming messages (default ``True``).
        certify_sent: Certify outgoing messages (default ``True``).
        batch_mode: Buffer certifications for batch sending (default ``False``).

    Returns:
        The :class:`XProofAutoGenHooks` instance (useful for calling
        :meth:`~XProofAutoGenHooks.flush` in batch mode).

    Example::

        from autogen import AssistantAgent
        from xproof.integrations.autogen import register_xproof_hooks

        assistant = AssistantAgent("analyst", llm_config={...})
        hooks = register_xproof_hooks(assistant, api_key="pm_...")
    """
    name: str = str(agent_name or getattr(agent, "name", "autogen-agent"))
    hooks = XProofAutoGenHooks(
        api_key=api_key,
        client=client,
        agent_name=name,
        certify_received=certify_received,
        certify_sent=certify_sent,
        batch_mode=batch_mode,
    )

    agent.register_hook(
        hookable_method="process_last_received_message",
        hook=hooks.on_received,
    )

    agent.register_hook(
        hookable_method="process_message_before_send",
        hook=hooks.on_send,
    )

    return hooks


def xproof_certify_decision(
    decision_text: str = "",
    file_hash: Optional[str] = None,
    confidence_level: float = 0.0,
    threshold_stage: str = "pre-commitment",
    decision_id: str = "",
    reversibility_class: Optional[str] = None,
    file_name: Optional[str] = None,
    author: str = "autogen-agent",
    who: Optional[str] = None,
    what: Optional[str] = None,
    when: Optional[str] = None,
    why: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
    api_key: str = "",
    client: Optional[XProofClient] = None,
) -> str:
    """Certify an AutoGen agent decision and gate on the compliance check.

    This is the AutoGen equivalent of LangChain's ``XProofCertifyTool`` — a
    plain callable that wraps :meth:`~xproof.XProofClient.certify_with_confidence`
    and :meth:`~xproof.XProofClient.get_policy_check` into a single call.

    Register it as a tool on any AutoGen agent using
    ``agent.register_for_llm`` / ``agent.register_for_execution``, or call it
    directly from an agent's reply function.

    Either ``decision_text`` (hashed automatically) or a pre-computed
    ``file_hash`` must be supplied; ``decision_text`` takes precedence.

    Args:
        decision_text: Raw text hashed to produce ``file_hash``.
        file_hash: Pre-computed 64-char hex SHA-256.  Used only when
            ``decision_text`` is empty.
        confidence_level: Agent's self-assessed confidence between 0.0 and
            1.0.
        threshold_stage: One of ``initial``, ``partial``,
            ``pre-commitment``, ``final``.
        decision_id: Shared ID linking proofs in the same decision chain.
        reversibility_class: ``reversible``, ``costly``, or
            ``irreversible``.
        file_name: Artifact label (defaults to
            ``<decision_id>-<stage>.json``).
        author: Agent identity used as the proof author and default
            ``who`` value.
        who: 4W — agent identity (defaults to *author*).
        what: 4W — action description (defaults to the hash).
        when: 4W — ISO-8601 timestamp (defaults to current UTC time).
        why: 4W — reason for the decision.
        metadata: Extra key-value pairs stored with the proof.
        api_key: Prove Before Act API key (ignored if *client* is provided).
        client: Pre-configured :class:`~xproof.client.XProofClient`.

    Returns:
        The on-chain ``transaction_hash`` when the policy check passes.

    Raises:
        ValueError: If neither ``decision_text`` nor ``file_hash`` is
            provided, or if ``decision_id`` is empty.
        PolicyViolationError: If ``get_policy_check`` reports one or
            more violations.

    Example::

        from xproof.integrations.autogen import xproof_certify_decision
        from xproof.exceptions import PolicyViolationError
        import json

        decision = {"action": "delete_records", "scope": "inactive", "records": 4821}

        try:
            tx_hash = xproof_certify_decision(
                decision_text=json.dumps(decision, sort_keys=True),
                confidence_level=0.97,
                threshold_stage="pre-commitment",
                decision_id="del-run-2026-04-20",
                reversibility_class="irreversible",
                why="Scheduled GDPR data-retention cleanup",
                author="data-hygiene-agent",
                api_key="pm_...",
            )
            print(f"Policy compliant — proceeding (tx: {tx_hash})")
        except PolicyViolationError as exc:
            for v in exc.violations:
                print(f"BLOCKED [POLICY VIOLATION] {v.rule} (proof_id={v.proof_id}, confidence_level={v.confidence_level}, threshold={v.threshold})")
    """
    if not decision_id:
        raise ValueError("decision_id must be provided.")

    if decision_text:
        resolved_hash = hashlib.sha256(decision_text.encode()).hexdigest()
    elif file_hash:
        resolved_hash = file_hash
    else:
        raise ValueError("Either decision_text or file_hash must be provided.")

    xproof_client = client or XProofClient(api_key=api_key)
    artifact_name = file_name or f"{decision_id}-{threshold_stage}.json"
    resolved_who = who if who is not None else author
    resolved_what = what if what is not None else resolved_hash
    resolved_when = when if when is not None else datetime.now(timezone.utc).isoformat()

    cert = xproof_client.certify_with_confidence(
        file_hash=resolved_hash,
        file_name=artifact_name,
        author=author,
        confidence_level=confidence_level,
        threshold_stage=threshold_stage,
        decision_id=decision_id,
        who=resolved_who,
        what=resolved_what,
        when=resolved_when,
        why=why,
        reversibility_class=cast(Optional[ReversibilityClass], reversibility_class),
        metadata=metadata,
    )

    check = xproof_client.get_policy_check(decision_id)

    if not check.policy_compliant:
        violation_lines = [
            f"[POLICY VIOLATION] {v.rule} (proof_id={v.proof_id}, confidence_level={v.confidence_level}, threshold={v.threshold})"
            for v in check.policy_violations
        ]
        summary = "; ".join(violation_lines)
        raise PolicyViolationError(
            message=f"Policy compliance check failed for decision '{decision_id}': {summary}",
            decision_id=decision_id,
            violations=check.policy_violations,
        )

    return cert.transaction_hash


try:
    from autogen import ConversableAgent as _ConversableAgent
except ImportError:
    _ConversableAgent = None

if _ConversableAgent is not None:

    class XProofConversableAgent(_ConversableAgent):  # type: ignore[misc]  # _ConversableAgent is Any when pyautogen is not installed
        """AutoGen ``ConversableAgent`` with built-in Prove Before Act certification.

        Requires the ``pyautogen`` package. On init, automatically registers
        hooks that certify all incoming and outgoing messages on-chain.

        Example::

            from xproof.integrations.autogen import XProofConversableAgent

            agent = XProofConversableAgent(
                "analyst",
                llm_config={...},
                xproof_api_key="pm_...",
            )
        """

        def __init__(
            self,
            name: str,
            xproof_api_key: str = "",
            xproof_client: Optional[XProofClient] = None,
            certify_received: bool = True,
            certify_sent: bool = True,
            xproof_batch_mode: bool = False,
            **kwargs: Any,
        ) -> None:
            super().__init__(name, **kwargs)
            self.xproof_hooks = register_xproof_hooks(
                agent=self,
                api_key=xproof_api_key,
                client=xproof_client,
                agent_name=name,
                certify_received=certify_received,
                certify_sent=certify_sent,
                batch_mode=xproof_batch_mode,
            )
