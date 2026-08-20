"""Fetch.ai uAgents + xProof: on-chain decision anchoring for autonomous agents.

Demonstrates the WHY+WHAT dual-certification pattern:
  WHY  = hash of the incoming message (the trigger / justification)
  WHAT = hash of the agent's response (the output to prove)

Both proofs share a ``decision_id`` so the full reasoning chain is
independently verifiable on MultiversX mainnet.

4W metadata per proof:
  WHO  = agent name ("research-agent")
  WHAT = SHA-256 hash of content
  WHEN = UTC timestamp
  WHY  = human-readable context / mandate

Install:
    pip install prove-before-act uagents
    # The xproof module name below is a legacy compatibility alias.

Run (demo — mocked API, no key required):
    python main.py

Production usage:
    Replace XProofClient.register() with XProofClient(api_key="pm_...")
    obtained from https://xproof.app
"""

import json
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from xproof import XProofClient
from xproof.integrations.fetchai import XProofuAgentMiddleware, xproof_handler, wrap_agent


# ---------------------------------------------------------------------------
# Demo helpers — simulates what a real uAgents Bureau would call
# ---------------------------------------------------------------------------

class ResearchQuery:
    """Simplified uAgent message model (mirrors uagents.Model)."""
    def __init__(self, topic: str, depth: str = "standard"):
        self.topic = topic
        self.depth = depth


class ResearchResponse:
    """Simplified uAgent response model."""
    def __init__(self, summary: str, sources: int, confidence: float):
        self.summary = summary
        self.sources = sources
        self.confidence = confidence


def mock_cert_response(prefix: str):
    """Create a realistic mock certification response."""
    proof_id = str(uuid.uuid4())
    mock = MagicMock()
    mock.id = proof_id
    mock.file_hash = f"sha256:{uuid.uuid4().hex}"
    mock.transaction_hash = f"0x{uuid.uuid4().hex[:40]}"
    return mock


# ---------------------------------------------------------------------------
# Production-style handler (shows the decorator pattern)
# ---------------------------------------------------------------------------

async def handle_research_query(ctx, sender: str, msg: ResearchQuery):
    """Message handler that would normally be decorated with @agent.on_message.

    In production:
        @agent.on_message(model=ResearchQuery)
        @xproof_handler(xp, incoming_context="Research query received from peer")
        async def handle_research_query(ctx, sender, msg): ...
    """
    # Simulate research work
    response = ResearchResponse(
        summary=f"Research on '{msg.topic}': Found 3 key findings. "
                f"Market data indicates strong momentum with {msg.depth} analysis.",
        sources=12,
        confidence=0.89,
    )
    return response


# ---------------------------------------------------------------------------
# Main demo
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("  xProof + Fetch.ai uAgents — decision anchoring demo")
    print("=" * 60)
    print()

    # --- Register / connect ---
    print("1. Registering agent with xProof...")
    with patch.object(XProofClient, 'certify_hash', side_effect=mock_cert_response):
        client = XProofClient.register("research-agent-fetchai")
        print(f"   Agent:          {client.registration.api_key[:18]}...")
        print(f"   Trial credits:  {client.registration.trial.remaining} free certifications")
        print()

        # Create middleware (in production: wrap_agent(agent, api_key="pm_..."))
        xp = XProofuAgentMiddleware(
            client=client,
            agent_name="research-agent",
        )

        # Simulate incoming message from another agent
        peer_address = "agent1q2x3y4z5a6b7c8d9e0f"
        incoming_msg = ResearchQuery(topic="Autonomous DeFi yield strategies", depth="deep")

        print("2. Incoming message from peer agent...")
        print(f"   From:    {peer_address}")
        print(f"   Topic:   {incoming_msg.topic}")
        print()

        # --- Certify WHY (the trigger) ---
        print("3. Certifying WHY (the trigger) on-chain...")
        decision_id = str(uuid.uuid4())

        why_proof = xp.certify_incoming(
            message=incoming_msg,
            sender=peer_address,
            context=f"Research query received: '{incoming_msg.topic}'",
            decision_id=decision_id,
        )
        print(f"   WHY proof ID:   {why_proof['proof_id']}")
        print(f"   Content hash:   {why_proof['file_hash'][:34]}...")
        print(f"   Verify:         https://xproof.app/proof/{why_proof['proof_id']}")
        print(f"   Decision ID:    {decision_id}")
        print()

        # --- Agent does its work ---
        print("4. Agent processing query...")
        import asyncio
        response = asyncio.run(handle_research_query(None, peer_address, incoming_msg))
        print(f"   Summary (first 60 chars): {response.summary[:60]}...")
        print(f"   Sources: {response.sources}  |  Confidence: {response.confidence:.0%}")
        print()

        # --- Certify WHAT (the output) ---
        print("5. Certifying WHAT (the response) on-chain...")
        what_proof = xp.certify_outgoing(
            response=response,
            recipient=peer_address,
            context="Research response produced for peer",
            decision_id=decision_id,
            confidence_level=response.confidence,
        )
        print(f"   WHAT proof ID:  {what_proof['proof_id']}")
        print(f"   Content hash:   {what_proof['file_hash'][:34]}...")
        print(f"   Verify:         https://xproof.app/proof/{what_proof['proof_id']}")
        print()

        # --- certify_action: one-call dual-certification ---
        print("6. One-call dual-certification with certify_action()...")
        second_query = ResearchQuery(topic="Base network USDC yield pools", depth="standard")
        second_response = ResearchResponse(
            summary="4 active yield pools identified. Top APY: 8.2% (Aave V3).",
            sources=6,
            confidence=0.94,
        )

        result = xp.certify_action(
            action_name="yield-research",
            inputs={"topic": second_query.topic, "depth": second_query.depth},
            outputs={"summary": second_response.summary, "confidence": second_response.confidence},
            why="Peer agent requested yield pool analysis for autonomous rebalancing",
            confidence_level=second_response.confidence,
        )
        print(f"   Decision ID:    {result['decision_id']}")
        print(f"   WHY proof ID:   {result['why_proof']['proof_id']}")
        print(f"   WHAT proof ID:  {result['what_proof']['proof_id']}")
        print()

        # --- Summary ---
        print("=" * 60)
        print("  Confidence trail — 3 proofs certified")
        print("=" * 60)
        all_proofs = [
            ("WHY — initial query", why_proof['proof_id'], decision_id),
            ("WHAT — initial response", what_proof['proof_id'], decision_id),
            ("WHY — yield query", result['why_proof']['proof_id'], result['decision_id']),
            ("WHAT — yield response", result['what_proof']['proof_id'], result['decision_id']),
        ]
        for label, pid, did in all_proofs:
            print(f"  {label}")
            print(f"    proof_id:    {pid}")
            print(f"    decision_id: {did}")
            print()

        print("  Every action is now independently auditable.")
        print("  Incident report: https://xproof.app/incident/{agent_address}")
        print()
        print("  Production setup:")
        print("    1. pip install prove-before-act uagents")
        print("    2. xp = wrap_agent(agent, api_key='pm_...')")
        print("    3. @agent.on_message(model=Query)")
        print("       @xproof_handler(xp)")
        print("       async def handler(ctx, sender, msg): ...")


if __name__ == "__main__":
    main()
