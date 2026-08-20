"""Async LCEL chain with XProofCertifyTool — runnable example.

Shows how to wire XProofCertifyTool into an async LangChain LCEL pipeline so
every LLM decision is certified on-chain without blocking the event loop.

The example uses a mock LLM and a mock xProof client so no API keys or network
access are required.

Run from the python-sdk directory:

    pip install -e .
    pip install langchain-core
    python examples/langchain_async_chain.py

Expected output: two certification proofs printed to stdout, the script exits 0.

Production wiring
-----------------
Replace the mock pieces with real ones:

    # `xproof` is the legacy module name retained by the canonical prove-before-act distribution.
    from xproof import XProofClient
    from xproof.integrations.crewai import XProofCertifyTool

    client = XProofClient(api_key="pm_...")
    tool   = XProofCertifyTool(client=client, agent_name="my-async-agent")

Then drop the tool into any async LCEL chain as shown below.
"""

import asyncio
import json
from typing import Any
from unittest.mock import MagicMock

# ── Lazy-import langchain-core so the script fails fast with a clear message ──
try:
    from langchain_core.runnables import RunnableLambda
except ImportError as exc:
    raise SystemExit(
        "langchain-core is required for this example.\nInstall it with:  pip install langchain-core"
    ) from exc

from xproof.integrations.crewai import XProofCertifyTool

# ── Mock helpers ──────────────────────────────────────────────────────────────


def build_mock_tool() -> XProofCertifyTool:
    """Return an XProofCertifyTool backed by a mock client."""
    mock_client = MagicMock()
    proof_counter = {"n": 0}

    def make_proof(*_: Any, **__: Any) -> MagicMock:
        proof_counter["n"] += 1
        n = proof_counter["n"]
        p = MagicMock()
        p.id = f"proof-async-{n:03d}"
        p.file_hash = f"sha256-mock-{n:03d}"
        p.transaction_hash = f"0xmvx{n:03d}"
        return p

    mock_client.certify_hash.side_effect = make_proof
    return XProofCertifyTool(client=mock_client, agent_name="async-lcel-agent")


async def mock_llm_call(prompt: str) -> str:
    """Simulate an async LLM response."""
    await asyncio.sleep(0)  # yield to the event loop (real LLM would await I/O)
    return f"[LLM answer to: {prompt!r}]"


# ── Async LCEL chain ──────────────────────────────────────────────────────────


def build_chain(tool: XProofCertifyTool) -> Any:
    """Build a two-step async LCEL chain:

    input prompt
        → async LLM call          (RunnableLambda wrapping an async function)
        → async xProof certify    (asyncio.to_thread so sync SDK never blocks)
    """

    async def llm_step(prompt: str) -> dict:
        response = await mock_llm_call(prompt)
        return {"prompt": prompt, "response": response}

    async def certify_step(data: dict) -> dict:
        # XProofCertifyTool._run() is synchronous — run it in a thread pool
        # so it never blocks the async event loop.
        # _run() accepts either a plain string or a JSON string with a "content" key.
        result_json = await asyncio.to_thread(
            tool._run,
            data["response"],
        )
        result = json.loads(result_json)
        return {
            **data,
            "proof_id": result.get("proof_id"),
            "file_hash": result.get("file_hash"),
            "tx_hash": result.get("transaction_hash"),
        }

    return RunnableLambda(llm_step) | RunnableLambda(certify_step)


# ── Main ──────────────────────────────────────────────────────────────────────


async def main() -> None:
    tool = build_mock_tool()
    chain = build_chain(tool)

    prompts = [
        "What is the capital of France?",
        "Summarise the quarterly earnings report.",
    ]

    print("=== Async LCEL chain with xProof certification ===\n")

    for prompt in prompts:
        result = await chain.ainvoke(prompt)
        print(f"Prompt  : {result['prompt']}")
        print(f"Response: {result['response']}")
        print(f"Proof ID: {result['proof_id']}")
        print(f"Tx hash : {result['tx_hash']}")
        print()

    print("Both decisions certified on-chain. Script exited cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
