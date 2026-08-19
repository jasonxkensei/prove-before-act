"""LangChain callback handler for automatic Prove Before Act certification."""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

try:
    from langchain_core.callbacks import BaseCallbackHandler
except ImportError:
    try:
        from langchain.callbacks.base import BaseCallbackHandler
    except ImportError as err:
        raise ImportError(
            "langchain is required for this integration. "
            "Install it with: pip install langchain-core"
        ) from err

from ..client import XProofClient
from ..models import Certification, CertifyEntry


def _hash_data(data: Any) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


class XProofCallbackHandler(BaseCallbackHandler):  # type: ignore[misc]  # BaseCallbackHandler is Any when langchain is not installed
    """LangChain callback handler that certifies agent actions on-chain.

    Automatically creates blockchain-anchored proofs for LLM calls,
    tool invocations, and chain completions using the Prove Before Act 4W framework.

    Example::

        from xproof.integrations.langchain import XProofCallbackHandler

        handler = XProofCallbackHandler(api_key="pm_...")
        chain.invoke(input, config={"callbacks": [handler]})
    """

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        agent_name: str = "langchain-agent",
        certify_llm: bool = True,
        certify_tools: bool = True,
        certify_chains: bool = False,
        batch_mode: bool = False,
    ) -> None:
        super().__init__()
        self.client = client or XProofClient(api_key=api_key)
        self.agent_name = agent_name
        self.certify_llm = certify_llm
        self.certify_tools = certify_tools
        self.certify_chains = certify_chains
        self.batch_mode = batch_mode
        self._pending: list[CertifyEntry] = []
        self._run_context: dict[str, str] = {}

    def _certify(
        self,
        action_type: str,
        data_hash: str,
        file_name: str,
        context: str = "",
        parent_run_id: Optional[str] = None,
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
                "framework": "langchain",
            },
        }
        if parent_run_id:
            entry["metadata"]["parent_run_id"] = parent_run_id

        if self.batch_mode:
            self._pending.append(entry)
        else:
            self.client.certify_hash(
                file_hash=entry["file_hash"],
                file_name=entry["file_name"],
                author=entry["author"],
                metadata=entry["metadata"],
            )

    def flush(self) -> list[Certification]:
        """Send all pending certifications in a batch.

        Returns:
            List of :class:`~xproof.models.Certification` objects, one per
            certified item.  Returns an empty list if there was nothing pending.
        """
        if not self._pending:
            return []
        result = self.client.batch_certify(self._pending)
        self._pending.clear()
        return result.results

    def on_llm_start(
        self,
        serialized: dict[str, Any],
        prompts: list[str],
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        if not self.certify_llm:
            return
        model_name = serialized.get("name", serialized.get("id", ["unknown"])[-1])
        prompt_hash = _hash_data(prompts)
        self._run_context[str(run_id)] = json.dumps(
            {"model": model_name, "prompt_hash": prompt_hash}
        )

    def on_llm_end(
        self,
        response: Any,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        if not self.certify_llm:
            return
        ctx_raw = self._run_context.pop(str(run_id), '{"model":"unknown-model","prompt_hash":""}')
        ctx = json.loads(ctx_raw)
        model_name = ctx["model"]
        prompt_hash = ctx["prompt_hash"]

        output_text = ""
        if hasattr(response, "generations"):
            for gen_list in response.generations:
                for gen in gen_list:
                    output_text += getattr(gen, "text", "")

        data_hash = _hash_data(
            {"model": model_name, "prompt_hash": prompt_hash, "output": output_text}
        )
        self._certify(
            action_type="llm_call",
            data_hash=data_hash,
            file_name=f"llm-{model_name}-{str(run_id)[:8]}.json",
            context=f"LLM call to {model_name}",
            parent_run_id=str(parent_run_id) if parent_run_id else None,
        )

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        if not self.certify_tools:
            return
        tool_name = serialized.get("name", "unknown-tool")
        input_hash = _hash_data(input_str)
        self._run_context[str(run_id)] = json.dumps({"tool": tool_name, "input_hash": input_hash})

    def on_tool_end(
        self,
        output: Any,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        if not self.certify_tools:
            return
        ctx_raw = self._run_context.pop(str(run_id), '{"tool":"unknown-tool","input_hash":""}')
        ctx = json.loads(ctx_raw)
        tool_name = ctx["tool"]
        input_hash = ctx["input_hash"]
        data_hash = _hash_data({"tool": tool_name, "input_hash": input_hash, "output": str(output)})
        self._certify(
            action_type="tool_call",
            data_hash=data_hash,
            file_name=f"tool-{tool_name}-{str(run_id)[:8]}.json",
            context=f"Tool invocation: {tool_name}",
            parent_run_id=str(parent_run_id) if parent_run_id else None,
        )

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        if not self.certify_chains:
            return
        chain_name = serialized.get("name", serialized.get("id", ["unknown"])[-1])
        self._run_context[str(run_id)] = chain_name

    def on_chain_end(
        self,
        outputs: dict[str, Any],
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        if self.certify_chains:
            chain_name = self._run_context.pop(str(run_id), "unknown-chain")
            data_hash = _hash_data({"chain": chain_name, "outputs": outputs})
            self._certify(
                action_type="chain_completion",
                data_hash=data_hash,
                file_name=f"chain-{chain_name}-{str(run_id)[:8]}.json",
                context=f"Chain completion: {chain_name}",
                parent_run_id=str(parent_run_id) if parent_run_id else None,
            )
        else:
            self._run_context.pop(str(run_id), None)

        if self.batch_mode and parent_run_id is None:
            self.flush()

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        self._run_context.pop(str(run_id), None)
        if self.batch_mode:
            self.flush()

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        self._run_context.pop(str(run_id), None)
