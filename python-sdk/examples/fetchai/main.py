"""Fetch.ai uAgents + xProof: on-chain certification for agent messages.

Demonstrates four common patterns for the XProofuAgentMiddleware:
  1. Certify an incoming message (WHY anchor)
  2. Certify an outgoing response (WHAT anchor)
  3. Toggle certification flags at runtime
  4. Batch mode — flush multiple proofs in one call

Run: python main.py

Requirements:
    pip install prove-before-act[fetchai]
    # The xproof module name below is a legacy compatibility alias.
"""

from unittest.mock import MagicMock

from xproof.integrations.fetchai import XProofuAgentMiddleware


def _make_mock_client() -> MagicMock:
    mock = MagicMock()
    mock.certify_hash.return_value = MagicMock(
        id="proof-fa-001",
        file_hash="abcdef1234567890" * 4,
        transaction_hash="tx-mvx-fetchai-demo",
    )
    mock.batch_certify.return_value = [
        MagicMock(id=f"proof-batch-{i}", transaction_hash=f"tx-batch-{i}") for i in range(3)
    ]
    return mock


def demo_certify_incoming(mw: XProofuAgentMiddleware, mock_client: MagicMock) -> None:
    print("1. Certify an incoming message (WHY anchor)")
    result = mw.certify_incoming(
        message={"query": "What is the current ETH price?"},
        sender="agent1qg5xkz9klm2mnv82n4cw8u6fxn2k8rdqmfxp7w",
        context="Price query received from orchestrator",
    )
    if result:
        print(f"   proof_id: {result['proof_id']}")
        print(f"   tx:       {result['transaction_hash']}")
    print()


def demo_certify_outgoing(mw: XProofuAgentMiddleware, mock_client: MagicMock) -> None:
    mock_client.certify_hash.reset_mock()
    print("2. Certify an outgoing response (WHAT anchor)")
    result = mw.certify_outgoing(
        response={"price": "3142.50", "currency": "USD", "source": "coingecko"},
        recipient="agent1qg5xkz9klm2mnv82n4cw8u6fxn2k8rdqmfxp7w",
        context="ETH price response",
        decision_id="price-query-dec-001",
    )
    if result:
        print(f"   proof_id: {result['proof_id']}")
        print(f"   tx:       {result['transaction_hash']}")
    print()


def demo_runtime_toggle(mw: XProofuAgentMiddleware, mock_client: MagicMock) -> None:
    mock_client.certify_hash.reset_mock()
    print("3. Toggle certification flags at runtime")

    print(f"   certify_incoming before: {bool(mw.certify_incoming)}")
    mw.certify_incoming = False
    print(f"   certify_incoming after disable: {bool(mw.certify_incoming)}")

    result = mw.certify_incoming(message="silenced", sender="a1")
    print(f"   certify_incoming() while disabled: {result}")

    mw.certify_incoming = True
    print(f"   certify_incoming re-enabled: {bool(mw.certify_incoming)}")

    mw.certify_outgoing = False
    print(f"   certify_outgoing disabled: {bool(mw.certify_outgoing)}")
    mw.certify_outgoing = True
    print()


def demo_batch_mode() -> None:
    mock_client = _make_mock_client()
    mw = XProofuAgentMiddleware(
        client=mock_client,
        agent_name="batch-price-agent",
        batch_mode=True,
    )

    print("4. Batch mode — accumulate proofs, then flush")
    for i, query in enumerate(["ETH price?", "BTC price?", "SOL price?"]):
        mw.certify_incoming(
            message={"query": query},
            sender="orchestrator",
            context=f"Query {i + 1}",
        )
    print(f"   {len(mw._pending)} proof(s) pending before flush")

    results = mw.flush()
    print(f"   flush() returned {len(results)} certified proof(s)")
    for r in results:
        print(f"     proof_id: {r.id}  tx: {r.transaction_hash}")
    print()


def main() -> None:
    mock_client = _make_mock_client()
    mw = XProofuAgentMiddleware(
        client=mock_client,
        agent_name="price-oracle-agent",
    )

    print("=== Fetch.ai uAgents + xProof Demo ===\n")
    demo_certify_incoming(mw, mock_client)
    demo_certify_outgoing(mw, mock_client)
    demo_runtime_toggle(mw, mock_client)
    demo_batch_mode()
    print("Done. All proofs anchored on-chain (mock mode).")


if __name__ == "__main__":
    main()
