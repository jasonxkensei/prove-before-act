"""AutoGen + xProof: Timing Breakdown example.

Shows how to certify AutoGen agent messages with a full decision chronology.
The timing breakdown captures:
  - instruction_received_at  — when the user sent the message
  - reasoning_started_at     — when the agent processed it
  - action_taken_at          — when the agent's reply was sent

For messages the agent inferred on its own, use ``autonomous_inference``
as the jurisdiction_type instead of ``instruction_following``.

Run: python timing_breakdown.py
"""

import hashlib
import json
import time
from datetime import datetime, timezone


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(data: object) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


def certify_agent_reply(
    client,
    agent_name: str,
    received_message: str,
    reply_message: str,
    decision_id: str,
    instruction_received_at: str,
    jurisdiction_type: str = "instruction_following",
) -> dict:
    """Certify one AutoGen message exchange with timing breakdown."""
    # `xproof` is the legacy module name retained by the canonical prove-before-act distribution.
    from xproof.models import TimingBreakdown

    reasoning_started_at = _now()
    time.sleep(0.05)  # simulate agent processing
    action_taken_at = _now()

    reply_hash = _hash({"agent": agent_name, "reply": reply_message})

    timing: TimingBreakdown = {
        "instruction_received_at": instruction_received_at,
        "reasoning_started_at": reasoning_started_at,
        "action_taken_at": action_taken_at,
        "jurisdiction_type": jurisdiction_type,
    }

    cert = client.certify_with_confidence(
        file_hash=reply_hash,
        file_name=f"{agent_name}-reply.json",
        author=agent_name,
        confidence_level=0.92,
        threshold_stage="final",
        decision_id=decision_id,
        reversibility_class="reversible",
        who=agent_name,
        what=reply_hash,
        when=action_taken_at,
        why=_hash(received_message),
        timing=timing,
    )

    return {
        "agent": agent_name,
        "proof_id": cert.id,
        "reply_hash": reply_hash,
        "timing_breakdown": cert.timing_breakdown,
    }


def main() -> None:
    from xproof import XProofClient

    client = XProofClient.register("autogen-timing-demo")
    print(f"Registered: {client.registration.api_key[:12]}...")
    print(f"Trial remaining: {client.registration.trial.remaining}")
    print()

    decision_id = "autogen-research-2026"

    # ── Turn 1: User → AssistantAgent ─────────────────────────────────────────
    user_message = "What are the key risks in the ACME Q1 2026 report?"
    instruction_received_at_1 = _now()
    print(f"[{instruction_received_at_1}] User → AssistantAgent:")
    print(f"  '{user_message}'")

    reply_1 = "Key risks: supply chain exposure, FX headwinds, slowing EU segment."
    result_1 = certify_agent_reply(
        client=client,
        agent_name="assistant-agent",
        received_message=user_message,
        reply_message=reply_1,
        decision_id=decision_id,
        instruction_received_at=instruction_received_at_1,
        # Human sent the prompt → instruction_following
        jurisdiction_type="instruction_following",
    )
    print(f"  Reply: '{reply_1}'")
    print(f"  Proof: {result_1['proof_id']}")
    if (
        result_1["timing_breakdown"]
        and result_1["timing_breakdown"].get("total_duration_ms") is not None
    ):
        print(f"  Total latency: {result_1['timing_breakdown']['total_duration_ms']} ms")
    print()

    # ── Turn 2: AssistantAgent → CriticAgent (autonomous follow-up) ───────────
    follow_up_message = reply_1
    instruction_received_at_2 = _now()
    print(f"[{instruction_received_at_2}] AssistantAgent → CriticAgent (autonomous):")
    print(f"  '{follow_up_message}'")

    critic_reply = (
        "Agreed on FX risk. Supply chain risk appears overstated — add confidence interval."
    )
    result_2 = certify_agent_reply(
        client=client,
        agent_name="critic-agent",
        received_message=follow_up_message,
        reply_message=critic_reply,
        decision_id=decision_id,
        instruction_received_at=instruction_received_at_2,
        # Agent-to-agent, no human in the loop → autonomous_inference
        jurisdiction_type="autonomous_inference",
    )
    print(f"  Reply: '{critic_reply}'")
    print(f"  Proof: {result_2['proof_id']}")
    if (
        result_2["timing_breakdown"]
        and result_2["timing_breakdown"].get("total_duration_ms") is not None
    ):
        print(f"  Total latency: {result_2['timing_breakdown']['total_duration_ms']} ms")
    print()

    print("── Summary ──────────────────────────────────────────────────────────")
    print(f"  Turn 1 proof: {result_1['proof_id']}  (jurisdiction: instruction_following)")
    print(f"  Turn 2 proof: {result_2['proof_id']}  (jurisdiction: autonomous_inference)")
    print()
    print(f"Decision chain '{decision_id}' anchored.")
    print("Each message-reply exchange is independently verifiable on-chain.")


if __name__ == "__main__":
    main()
