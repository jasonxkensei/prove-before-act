"""LlamaIndex callback handler for automatic Prove Before Act certification."""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional

try:
    from llama_index.core.callbacks.base import BaseCallbackHandler
    from llama_index.core.callbacks.schema import CBEventType
except ImportError:
    try:
        from llama_index.callbacks.base import BaseCallbackHandler
        from llama_index.callbacks.schema import CBEventType
    except ImportError as err:
        raise ImportError(
            "llama-index-core is required for this integration. "
            "Install it with: pip install llama-index-core"
        ) from err

from ..client import XProofClient
from ..models import CertifyEntry


def _hash_data(data: Any) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


class XProofCallbackHandler(BaseCallbackHandler):  # type: ignore[misc]  # BaseCallbackHandler is Any when llama-index is not installed
    """LlamaIndex callback handler that certifies agent actions on-chain.

    Automatically creates blockchain-anchored proofs for LLM calls,
    query completions, and function/tool calls using the Prove Before Act 4W framework.

    Example::

        from llama_index.core.callbacks import CallbackManager
        from xproof.integrations.llamaindex import XProofLlamaIndexHandler

        handler = XProofLlamaIndexHandler(api_key="pm_...")
        callback_manager = CallbackManager([handler])
        index.as_query_engine(callback_manager=callback_manager)
    """

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        agent_name: str = "llamaindex-agent",
        certify_llm: bool = True,
        certify_query: bool = True,
        certify_function_call: bool = True,
        batch_mode: bool = False,
    ) -> None:
        ignored = [
            et
            for et in CBEventType
            if et not in (CBEventType.LLM, CBEventType.QUERY, CBEventType.FUNCTION_CALL)
        ]
        super().__init__(
            event_starts_to_ignore=ignored,
            event_ends_to_ignore=ignored,
        )
        self.client = client or XProofClient(api_key=api_key)
        self.agent_name = agent_name
        self.certify_llm = certify_llm
        self.certify_query = certify_query
        self.certify_function_call = certify_function_call
        self.batch_mode = batch_mode
        self._pending: list[CertifyEntry] = []
        self._event_context: dict[str, dict[str, Any]] = {}

    def _should_trace(self, event_type: CBEventType) -> bool:
        if event_type == CBEventType.LLM:
            return self.certify_llm
        if event_type == CBEventType.QUERY:
            return self.certify_query
        if event_type == CBEventType.FUNCTION_CALL:
            return self.certify_function_call
        return False

    def _certify(
        self,
        action_type: str,
        data_hash: str,
        file_name: str,
        context: str = "",
        event_id: Optional[str] = None,
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
                "framework": "llamaindex",
            },
        }
        if event_id:
            entry["metadata"]["event_id"] = event_id

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

    def start_trace(self, trace_id: Optional[str] = None) -> None:
        pass

    def end_trace(
        self,
        trace_id: Optional[str] = None,
        trace_map: Optional[dict[str, list[str]]] = None,
    ) -> None:
        if self.batch_mode:
            self.flush()

    def on_event_start(
        self,
        event_type: CBEventType,
        payload: Optional[dict[str, Any]] = None,
        event_id: str = "",
        parent_id: str = "",
        **kwargs: Any,
    ) -> str:
        if self._should_trace(event_type) and payload is not None:
            self._event_context[event_id] = {
                "event_type": event_type,
                "payload_hash": _hash_data(payload),
                "parent_id": parent_id,
            }
        return event_id

    def on_event_end(
        self,
        event_type: CBEventType,
        payload: Optional[dict[str, Any]] = None,
        event_id: str = "",
        **kwargs: Any,
    ) -> None:
        if not self._should_trace(event_type):
            return

        ctx = self._event_context.pop(event_id, {})
        start_hash = ctx.get("payload_hash", "")

        if event_type == CBEventType.LLM:
            response_text = ""
            if payload:
                response_obj = payload.get("response", payload.get("completion", ""))
                response_text = str(response_obj) if response_obj else ""
                if not response_text:
                    messages = payload.get("messages", [])
                    if messages:
                        response_text = str(messages)
            data_hash = _hash_data(
                {
                    "event_type": "llm",
                    "start_hash": start_hash,
                    "output": response_text,
                }
            )
            self._certify(
                action_type="llm_call",
                data_hash=data_hash,
                file_name=f"llm-llamaindex-{event_id[:8]}.json",
                context="LlamaIndex LLM call",
                event_id=event_id,
            )

        elif event_type == CBEventType.QUERY:
            query_result = ""
            if payload:
                result_obj = payload.get("response", "")
                query_result = str(result_obj) if result_obj else ""
            data_hash = _hash_data(
                {
                    "event_type": "query",
                    "start_hash": start_hash,
                    "output": query_result,
                }
            )
            self._certify(
                action_type="query",
                data_hash=data_hash,
                file_name=f"query-llamaindex-{event_id[:8]}.json",
                context="LlamaIndex query completion",
                event_id=event_id,
            )

        elif event_type == CBEventType.FUNCTION_CALL:
            tool_output = ""
            tool_name = "unknown-tool"
            if payload:
                tool_output = str(payload.get("function_call_response", ""))
                tool_name = str(payload.get("tool", payload.get("function_call", "unknown-tool")))
            data_hash = _hash_data(
                {
                    "event_type": "function_call",
                    "tool": tool_name,
                    "start_hash": start_hash,
                    "output": tool_output,
                }
            )
            self._certify(
                action_type="function_call",
                data_hash=data_hash,
                file_name=f"tool-{tool_name}-{event_id[:8]}.json",
                context=f"Tool invocation: {tool_name}",
                event_id=event_id,
            )


XProofLlamaIndexHandler = XProofCallbackHandler
