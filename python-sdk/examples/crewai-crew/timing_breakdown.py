"""CrewAI + xProof: Timing Breakdown example.

Shows how to use certify_with_confidence() with a TimingBreakdown inside
a CrewAI-style agent workflow. Each task anchors its full chronology:
  - instruction_received_at  — when the crew task was assigned
  - reasoning_started_at     — when the agent started working
  - action_taken_at          — when the task output was produced

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


def simulate_crew_task(
    client,
    agent_role: str,
    task_description: str,
    output: str,
    decision_id: str,
    reversibility_class: str = "reversible",
) -> dict:
    """Simulate one CrewAI task step and certify it with timing breakdown."""
    # ── Timing markers ────────────────────────────────────────────────────────
    instruction_received_at = _now()
    print(f"  [{instruction_received_at}] Task assigned to '{agent_role}'")

    time.sleep(0.05)  # simulate reasoning latency
    reasoning_started_at = _now()

    time.sleep(0.05)  # simulate execution latency
    action_taken_at = _now()

    output_hash = _hash({"role": agent_role, "output": output})

    # `xproof` is the legacy module name retained by the canonical prove-before-act distribution.
    from xproof.models import TimingBreakdown

    timing: TimingBreakdown = {
        "instruction_received_at": instruction_received_at,
        "reasoning_started_at": reasoning_started_at,
        "action_taken_at": action_taken_at,
        # CrewAI tasks are driven by a human-defined crew — instruction_following
        "jurisdiction_type": "instruction_following",
    }

    cert = client.certify_with_confidence(
        file_hash=output_hash,
        file_name=f"{agent_role}-output.json",
        author=agent_role,
        confidence_level=0.95,
        threshold_stage="final",
        decision_id=decision_id,
        reversibility_class=reversibility_class,
        who=agent_role,
        what=output_hash,
        when=action_taken_at,
        why=_hash(task_description),
        timing=timing,
    )

    print(f"  [{action_taken_at}] Task completed → Proof {cert.id}")
    if cert.timing_breakdown and cert.timing_breakdown.get("total_duration_ms") is not None:
        print(f"    Total latency: {cert.timing_breakdown['total_duration_ms']} ms")

    return {
        "agent_role": agent_role,
        "proof_id": cert.id,
        "file_hash": output_hash,
        "transaction_hash": cert.transaction_hash,
    }


def main() -> None:
    from xproof import XProofClient

    client = XProofClient.register("crewai-timing-demo")
    print(f"Registered: {client.registration.api_key[:12]}...")
    print(f"Trial remaining: {client.registration.trial.remaining}")
    print()

    decision_id = "crew-report-2026-q1"

    print("── Agent 1: Researcher ─────────────────────────────────────────────")
    r1 = simulate_crew_task(
        client=client,
        agent_role="researcher",
        task_description="Research Q1 2026 earnings data for ACME Corp",
        output="ACME Q1 2026: revenue +18% YoY, net margin 12%.",
        decision_id=decision_id,
    )
    print()

    print("── Agent 2: Writer ─────────────────────────────────────────────────")
    r2 = simulate_crew_task(
        client=client,
        agent_role="writer",
        task_description="Write an executive summary from the research",
        output="Executive Summary: ACME delivered strong Q1 2026 results with 18% revenue growth.",
        decision_id=decision_id,
    )
    print()

    print("── Agent 3: Reviewer ────────────────────────────────────────────────")
    r3 = simulate_crew_task(
        client=client,
        agent_role="reviewer",
        task_description="Review the executive summary for accuracy",
        output="Reviewed. Report is accurate and well-structured. Approved.",
        decision_id=decision_id,
        reversibility_class="reversible",
    )
    print()

    print("── Summary ──────────────────────────────────────────────────────────")
    for step in (r1, r2, r3):
        print(f"  {step['agent_role']:12s} → proof {step['proof_id']}")

    print()
    print(f"Decision chain '{decision_id}' fully anchored with timing breakdown.")
    print("Each step's instruction→reasoning→action chronology is on-chain.")


if __name__ == "__main__":
    main()
