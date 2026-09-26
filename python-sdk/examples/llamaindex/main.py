"""LlamaIndex + xProof: automatic query and LLM call certification.

Uses XProofCallbackHandler to certify every LLM interaction and
query completion with 4W metadata (WHO, WHAT, WHEN, WHY) on MultiversX.

Run: python main.py

Note: This example uses the callback handler directly without
a real LlamaIndex index. In production, pass the handler to your
LlamaIndex CallbackManager.

Production usage::

    from llama_index.core.callbacks import CallbackManager
    # `xproof` is the legacy module name retained by the canonical prove-before-act distribution.
    from xproof.integrations.llamaindex import XProofCallbackHandler

    handler = XProofCallbackHandler(api_key="pm_...")
    callback_manager = CallbackManager([handler])

    # Attach to your query engine
    query_engine = index.as_query_engine(callback_manager=callback_manager)
    response = query_engine.query("What is AI?")
"""

from llama_index.core.callbacks.schema import CBEventType
from xproof import XProofClient
from xproof.integrations.llamaindex import XProofCallbackHandler


def main():
    client = XProofClient.register("llamaindex-demo")
    print(f"Registered: {client.registration.api_key[:12]}...")
    print(f"Trial remaining: {client.registration.trial.remaining}")
    print()

    handler = XProofCallbackHandler(
        client=client,
        agent_name="llamaindex-demo-agent",
        batch_mode=True,
    )

    print("--- Simulating LlamaIndex query pipeline ---")
    print()

    handler.start_trace(trace_id="demo-trace")

    event_id_1 = "evt-llm-1"
    handler.on_event_start(
        event_type=CBEventType.LLM,
        payload={"messages": ["What is the capital of France?"]},
        event_id=event_id_1,
    )
    print("  LLM call started: 'What is the capital of France?'")

    handler.on_event_end(
        event_type=CBEventType.LLM,
        payload={"response": "Paris is the capital of France."},
        event_id=event_id_1,
    )
    print("  LLM call completed: 'Paris is the capital of France.'")
    print()

    event_id_2 = "evt-query-1"
    handler.on_event_start(
        event_type=CBEventType.QUERY,
        payload={"query_str": "Explain quantum computing"},
        event_id=event_id_2,
    )
    print("  Query started: 'Explain quantum computing'")

    handler.on_event_end(
        event_type=CBEventType.QUERY,
        payload={"response": "Quantum computing uses qubits..."},
        event_id=event_id_2,
    )
    print("  Query completed: 'Quantum computing uses qubits...'")
    print()

    print("--- Ending trace (triggers batch flush) ---")
    handler.end_trace(trace_id="demo-trace")
    print("  Flushed pending certifications (all sent)")
    print()
    print("All LlamaIndex interactions are independently verifiable on-chain.")


if __name__ == "__main__":
    main()
