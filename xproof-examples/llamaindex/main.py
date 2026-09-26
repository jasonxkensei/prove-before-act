"""LlamaIndex + xProof: certify LLM calls and query completions on-chain.

Each event produces a certification with 4W metadata:
  WHO  = your agent name
  WHAT = SHA-256 hash of the response
  WHEN = UTC timestamp
  WHY  = event type (LLM, QUERY)

Install:
    pip install prove-before-act llama-index-core
    # The xproof module name below is a legacy compatibility alias.

Run:
    python main.py

Production usage — attach to a LlamaIndex query engine:
    from llama_index.core.callbacks import CallbackManager
    from xproof import XProofClient
    from xproof.integrations.llamaindex import XProofCallbackHandler

    client = XProofClient(api_key="pm_...")   # get key at xproof.app
    handler = XProofCallbackHandler(client=client, agent_name="my-agent")
    callback_manager = CallbackManager([handler])

    query_engine = index.as_query_engine(callback_manager=callback_manager)
    response = query_engine.query("What is the market outlook for 2025?")
"""

from unittest.mock import MagicMock

from llama_index.core.callbacks.schema import CBEventType

from xproof.integrations.llamaindex import XProofCallbackHandler


def main():
    mock_client = MagicMock()
    mock_client.certify_hash.return_value = MagicMock(
        id="proof-li-001",
        file_hash="abc123def456",
        transaction_hash="tx-mvx-001",
    )

    handler = XProofCallbackHandler(
        client=mock_client,
        agent_name="llamaindex-demo-agent",
        batch_mode=True,
    )

    print("=== LlamaIndex xProof Certification Demo ===\n")

    print("Starting trace...")
    handler.start_trace(trace_id="demo-trace")

    event_id_1 = "evt-llm-1"
    handler.on_event_start(
        event_type=CBEventType.LLM,
        payload={"messages": ["What is the capital of France?"]},
        event_id=event_id_1,
    )
    print("LLM call started: 'What is the capital of France?'")

    handler.on_event_end(
        event_type=CBEventType.LLM,
        payload={"response": "Paris is the capital of France."},
        event_id=event_id_1,
    )
    print("LLM call completed: 'Paris is the capital of France.'")

    event_id_2 = "evt-query-1"
    handler.on_event_start(
        event_type=CBEventType.QUERY,
        payload={"query_str": "Explain quantum computing"},
        event_id=event_id_2,
    )
    print("Query started: 'Explain quantum computing'")

    handler.on_event_end(
        event_type=CBEventType.QUERY,
        payload={"response": "Quantum computing uses qubits..."},
        event_id=event_id_2,
    )
    print("Query completed: 'Quantum computing uses qubits...'")

    print("\nEnding trace (triggers batch flush)...")
    captured = list(handler._pending)
    handler.end_trace(trace_id="demo-trace")

    print(f"\nbatch_certify called: {mock_client.batch_certify.called}")
    print(f"Certifications flushed: {len(captured)}")

    if captured:
        meta = captured[0]["metadata"]
        print("\nFirst certification metadata (4W framework):")
        print(f"  who:       {meta['who']}")
        print(f"  what:      {meta['what'][:16]}...")
        print(f"  when:      {meta['when']}")
        print(f"  why:       {meta['why']}")
        print(f"  framework: {meta['framework']}")

    print()
    print("In production, replace mock_client with XProofClient(api_key='pm_...')")
    print("Each certification is verifiable at https://xproof.app/verify/<proof_id>")


if __name__ == "__main__":
    main()
