"""LangChain + xProof: certify every LLM call on the MultiversX blockchain.

Each LLM response is certified with 4W metadata:
  WHO  = your agent name
  WHAT = SHA-256 hash of the LLM response
  WHEN = UTC timestamp
  WHY  = "llm_response"

Install:
    pip install prove-before-act langchain-core
    # The xproof module name below is a legacy compatibility alias.

Run:
    python main.py

Production usage — attach to any LangChain chain:
    from xproof import XProofClient
    from xproof.integrations.langchain import XProofCallbackHandler

    client = XProofClient(api_key="pm_...")   # get key at xproof.app
    handler = XProofCallbackHandler(client=client, agent_name="my-agent")
    chain = your_chain.with_config(callbacks=[handler])
"""

import uuid
from unittest.mock import MagicMock

from xproof.integrations.langchain import XProofCallbackHandler


def main():
    mock_client = MagicMock()
    mock_client.certify_hash.return_value = MagicMock(
        id="proof-lc-001",
        file_hash="abc123def456",
        transaction_hash="tx-mvx-001",
    )

    handler = XProofCallbackHandler(
        client=mock_client,
        agent_name="langchain-demo-agent",
        batch_mode=True,
    )

    print("=== LangChain xProof Certification Demo ===\n")

    run_id_1 = uuid.uuid4()
    handler.on_llm_start(
        serialized={"name": "ChatOpenAI"},
        prompts=["What is the capital of France?"],
        run_id=run_id_1,
        parent_run_id=None,
    )
    print("LLM call 1 started: 'What is the capital of France?'")

    handler.on_llm_end(
        response=type("Response", (), {
            "generations": [[type("Gen", (), {"text": "Paris is the capital of France."})()]],
            "llm_output": {"model_name": "gpt-4"},
        })(),
        run_id=run_id_1,
    )
    print("LLM call 1 completed: 'Paris is the capital of France.'")

    run_id_2 = uuid.uuid4()
    handler.on_llm_start(
        serialized={"name": "ChatOpenAI"},
        prompts=["Translate 'hello' to Spanish"],
        run_id=run_id_2,
        parent_run_id=None,
    )
    print("LLM call 2 started: 'Translate hello to Spanish'")

    handler.on_llm_end(
        response=type("Response", (), {
            "generations": [[type("Gen", (), {"text": "Hola"})()]],
            "llm_output": {"model_name": "gpt-4"},
        })(),
        run_id=run_id_2,
    )
    print("LLM call 2 completed: 'Hola'")

    pending_count = len(handler._pending)
    print(f"\nPending certifications before flush: {pending_count}")
    captured = list(handler._pending)
    handler.flush()
    print(f"Flushed!  batch_certify called: {mock_client.batch_certify.called}")

    print("\nCertification metadata (4W framework) — call 1:")
    entry = captured[0]
    meta = entry["metadata"]
    print(f"  who:       {meta['who']}")
    print(f"  what:      {meta['what'][:16]}...")
    print(f"  when:      {meta['when']}")
    print(f"  why:       {meta['why']}")
    print(f"  framework: {meta['framework']}")
    print(f"  author:    {entry['author']}")

    print(f"\nTotal LLM calls certified: {len(captured)}")
    print()
    print("In production, replace mock_client with XProofClient(api_key='pm_...')")
    print("Each certification is verifiable at https://xproof.app/verify/<proof_id>")


if __name__ == "__main__":
    main()
