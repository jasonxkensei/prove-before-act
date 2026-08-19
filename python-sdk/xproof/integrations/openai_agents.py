"""OpenAI Agents SDK integration for automatic Prove Before Act certification.

Provides ``XProofRunHooks`` (extends ``RunHooks``) and an optional
``XProofTracingProcessor`` (implements ``TracingProcessor``) that
auto-certify agent and tool outputs on-chain using the Prove Before Act 4W
framework (Who, What, When, Why).

Targets the official ``openai-agents`` package.
"""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional

from ..client import XProofClient
from ..models import CertifyEntry


def _hash_data(data: Any) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


class XProofRunHooks:
    """OpenAI Agents SDK ``RunHooks`` implementation for Prove Before Act certification.

    Hooks into ``on_tool_end`` and ``on_agent_end`` to automatically
    certify tool outputs and final agent responses with 4W metadata.

    When the real ``openai-agents`` package is available this class
    also inherits from ``agents.RunHooks`` so it can be passed directly
    to ``Runner.run(hooks=...)``.

    Example::

        from xproof.integrations.openai_agents import XProofRunHooks

        hooks = XProofRunHooks(api_key="pm_...")
        result = await Runner.run(agent, input="...", hooks=hooks)
    """

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        agent_name: str = "openai-agent",
        certify_tools: bool = True,
        certify_agent: bool = True,
        batch_mode: bool = False,
    ) -> None:
        self.client = client or XProofClient(api_key=api_key)
        self.agent_name = agent_name
        self.certify_tools = certify_tools
        self.certify_agent = certify_agent
        self.batch_mode = batch_mode
        self._pending: list[CertifyEntry] = []

    def _certify(
        self,
        action_type: str,
        data_hash: str,
        file_name: str,
        context: str = "",
        who_override: Optional[str] = None,
    ) -> None:
        who = who_override or self.agent_name
        entry: CertifyEntry = {
            "file_hash": data_hash,
            "file_name": file_name,
            "author": who,
            "metadata": {
                "who": who,
                "what": data_hash,
                "when": datetime.now(timezone.utc).isoformat(),
                "why": context or action_type,
                "action_type": action_type,
                "framework": "openai-agents",
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

    async def on_tool_end(self, context: Any, agent: Any, tool: Any, result: Any) -> None:
        """Certify a completed tool invocation.

        Args:
            context: The ``RunContextWrapper`` from the Agents SDK.
            agent: The ``Agent`` that invoked the tool.
            tool: The tool that was invoked.
            result: The tool's return value / output string.
        """
        if not self.certify_tools:
            return

        tool_name = getattr(tool, "name", str(tool))
        agent_label = getattr(agent, "name", self.agent_name)

        data_hash = _hash_data(
            {
                "tool": tool_name,
                "agent": agent_label,
                "output": str(result),
            }
        )
        self._certify(
            action_type="tool_end",
            data_hash=data_hash,
            file_name=f"tool-{tool_name}-{data_hash[:8]}.json",
            context=f"Tool {tool_name} completed by {agent_label}",
            who_override=agent_label,
        )

    async def on_agent_end(self, context: Any, agent: Any, output: Any) -> None:
        """Certify a completed agent run.

        Args:
            context: The ``RunContextWrapper`` from the Agents SDK.
            agent: The ``Agent`` that finished.
            output: The agent's final output.
        """
        if not self.certify_agent:
            return

        agent_label = getattr(agent, "name", self.agent_name)

        data_hash = _hash_data(
            {
                "agent": agent_label,
                "output": str(output),
            }
        )
        self._certify(
            action_type="agent_end",
            data_hash=data_hash,
            file_name=f"agent-{agent_label}-{data_hash[:8]}.json",
            context=f"Agent {agent_label} run completed",
            who_override=agent_label,
        )

        if self.batch_mode:
            self.flush()

    async def on_agent_start(self, context: Any, agent: Any) -> None:
        """Called when an agent starts. No-op by default."""

    async def on_tool_start(self, context: Any, agent: Any, tool: Any) -> None:
        """Called when a tool starts. No-op by default."""

    async def on_handoff(self, context: Any, from_agent: Any, to_agent: Any) -> None:
        """Called on agent handoff. No-op by default."""


try:
    from agents import RunHooks as _RunHooks

    class XProofRunHooks(XProofRunHooks, _RunHooks):  # type: ignore[no-redef, misc]  # _RunHooks is Any when openai-agents is not installed; no-redef for conditional redefinition
        pass
except ImportError:
    pass


class XProofTracingProcessor:
    """Span-based tracing processor for Prove Before Act certification.

    Implements the ``TracingProcessor`` interface from the OpenAI Agents
    SDK.  Certifies completed spans whose kind is ``tool``, ``function``
    (the real type used for local tools in the SDK), or ``agent``.

    Example::

        from xproof.integrations.openai_agents import XProofTracingProcessor
        from agents.tracing import add_trace_processor

        processor = XProofTracingProcessor(api_key="pm_...")
        add_trace_processor(processor)
    """

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        agent_name: str = "openai-agent",
        certify_tool_spans: bool = True,
        certify_agent_spans: bool = True,
    ) -> None:
        self.client = client or XProofClient(api_key=api_key)
        self.agent_name = agent_name
        self.certify_tool_spans = certify_tool_spans
        self.certify_agent_spans = certify_agent_spans
        self._pending: list[CertifyEntry] = []

    def _certify(
        self,
        action_type: str,
        data_hash: str,
        file_name: str,
        context: str = "",
        who_override: Optional[str] = None,
    ) -> None:
        who = who_override or self.agent_name
        entry: CertifyEntry = {
            "file_hash": data_hash,
            "file_name": file_name,
            "author": who,
            "metadata": {
                "who": who,
                "what": data_hash,
                "when": datetime.now(timezone.utc).isoformat(),
                "why": context or action_type,
                "action_type": action_type,
                "framework": "openai-agents",
            },
        }
        self.client.certify_hash(
            file_hash=entry["file_hash"],
            file_name=entry["file_name"],
            author=entry["author"],
            metadata=entry["metadata"],
        )

    def on_span_start(self, span: Any) -> None:
        """Called when a span starts. No-op — certification happens on end."""

    def on_span_end(self, span: Any) -> None:
        """Certify a completed span if its kind is tool, function, or agent.

        The OpenAI Agents SDK uses ``"function"`` for local tool spans
        (``FunctionSpanData.type``), not ``"tool"``.  Both are accepted so
        the processor works regardless of which SDK version is installed.
        """
        span_data = getattr(span, "span_data", None)
        if span_data is None:
            return

        kind = getattr(span_data, "type", None)

        if kind in ("tool", "function") and self.certify_tool_spans:
            # Fallback chain for name: span_data.name → self.agent_name
            tool_name = getattr(span_data, "name", None) or self.agent_name
            # Robust output fallback: FunctionSpanData may expose output under
            # different attribute names across SDK versions.  Try "output" first,
            # then "result" (used in some pre-release builds), then empty string.
            # Use explicit None checks to preserve valid falsey values (0, False, "").
            output = getattr(span_data, "output", None)
            if output is None:
                output = getattr(span_data, "result", None)
            if output is None:
                output = ""
            data_hash = _hash_data(
                {
                    "span_kind": kind,
                    "tool": tool_name,
                    "output": str(output),
                }
            )
            self._certify(
                action_type="tool_span_end",
                data_hash=data_hash,
                file_name=f"span-tool-{tool_name}-{data_hash[:8]}.json",
                context=f"Tool span {tool_name} completed",
                who_override=tool_name,
            )
        elif kind == "agent" and self.certify_agent_spans:
            agent_label = getattr(span_data, "name", self.agent_name)
            output = getattr(span_data, "output", "")
            data_hash = _hash_data(
                {
                    "span_kind": "agent",
                    "agent": agent_label,
                    "output": str(output),
                }
            )
            self._certify(
                action_type="agent_span_end",
                data_hash=data_hash,
                file_name=f"span-agent-{agent_label}-{data_hash[:8]}.json",
                context=f"Agent span {agent_label} completed",
                who_override=agent_label,
            )

    def force_flush(self) -> None:
        """Flush pending data. Currently a no-op (each span certifies immediately)."""

    def shutdown(self) -> None:
        """Shutdown the processor. Currently a no-op."""


try:
    from agents.tracing import TracingProcessor as _TracingProcessor

    class XProofTracingProcessor(XProofTracingProcessor, _TracingProcessor):  # type: ignore[no-redef, misc]  # _TracingProcessor is Any when openai-agents is not installed; no-redef for conditional redefinition
        pass
except ImportError:
    pass
