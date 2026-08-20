"""LangChain + xProof: automatic LLM call certification.

Uses XProofCallbackHandler to certify every LLM interaction
with 4W metadata (WHO, WHAT, WHEN, WHY) on MultiversX.

Run: python main.py

Note: This example uses the callback handler directly without
a real LLM. In production, pass the handler to your LangChain
chain's callbacks parameter.
"""

import uuid

# `xproof` is the legacy module name retained by the canonical prove-before-act distribution.
from xproof import XProofClient
from xproof.integrations.langchain import XProofCallbackHandler


def main():
    client = XProofClient.register("langchain-demo")
    print(f"Registered: {client.registration.api_key[:12]}...")
    print(f"Trial remaining: {client.registration.trial.remaining}")
    print()

    handler = XProofCallbackHandler(
        client=client,
        agent_name="langchain-demo-agent",
        batch_mode=True,
    )

    print("--- Simulating LangChain LLM calls ---")
    print()

    run_id_1 = uuid.uuid4()
    handler.on_llm_start(
        serialized={"name": "ChatOpenAI"},
        prompts=["What is the capital of France?"],
        run_id=run_id_1,
        parent_run_id=None,
    )
    print("  LLM call 1 started: 'What is the capital of France?'")

    handler.on_llm_end(
        response=type(
            "Response",
            (),
            {
                "generations": [[type("Gen", (), {"text": "Paris is the capital of France."})()]],
                "llm_output": {"model_name": "gpt-4"},
            },
        )(),
        run_id=run_id_1,
    )
    print("  LLM call 1 completed: 'Paris is the capital of France.'")
    print()

    run_id_2 = uuid.uuid4()
    handler.on_llm_start(
        serialized={"name": "ChatOpenAI"},
        prompts=["Translate 'hello' to Spanish"],
        run_id=run_id_2,
        parent_run_id=None,
    )
    print("  LLM call 2 started: 'Translate hello to Spanish'")

    handler.on_llm_end(
        response=type(
            "Response",
            (),
            {
                "generations": [[type("Gen", (), {"text": "Hola"})()]],
                "llm_output": {"model_name": "gpt-4"},
            },
        )(),
        run_id=run_id_2,
    )
    print("  LLM call 2 completed: 'Hola'")
    print()

    print("--- Flushing batch certifications ---")
    results = handler.flush()
    print(f"  Certified {len(results)} LLM calls in batch")
    for r in results:
        print(f"    Proof: {r.id} | Hash: {r.file_hash[:16]}...")
    print()

    print("--- Verification ---")
    for r in results:
        verified = client.verify(r.id)
        status = "verified" if verified.id == r.id else "FAILED"
        print(f"  {r.id}: {status}")

    print()
    print("All LLM interactions are independently verifiable on-chain.")


if __name__ == "__main__":
    main()
