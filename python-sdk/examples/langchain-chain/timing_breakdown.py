"""LangChain + xProof: Timing Breakdown example.

Demonstrates how to anchor the full decision chronology on-chain
when using LangChain. Three ISO8601 timestamps mark:
  - instruction_received_at  — when the human prompt arrived
  - reasoning_started_at     — when the LLM started thinking
  - action_taken_at          — when the chain produced its output

A ``jurisdiction_type`` field captures who is accountable.

Run: python timing_breakdown.py
"""

import hashlib
import json
from datetime import datetime, timezone


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(data: object) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


def main() -> None:
    # `xproof` is the legacy module name retained by the canonical prove-before-act distribution.
    from xproof import XProofClient
    from xproof.models import TimingBreakdown

    client = XProofClient.register("langchain-timing-demo")
    print(f"Registered: {client.registration.api_key[:12]}...")
    print(f"Trial remaining: {client.registration.trial.remaining}")
    print()

    # ── Step 1: instruction arrives ──────────────────────────────────────────
    instruction_received_at = _now()
    user_prompt = "Summarise the Q1 2026 earnings report for ACME Corp."
    print(f"[{instruction_received_at}] Instruction received: '{user_prompt}'")

    # ── Step 2: LLM starts reasoning ─────────────────────────────────────────
    reasoning_started_at = _now()
    print(f"[{reasoning_started_at}] LangChain chain invoked — reasoning started")

    # Simulate the chain output
    chain_output = {
        "summary": "ACME Q1 2026: revenue +18% YoY, net margin 12%, strong AI segment.",
        "model": "gpt-4o",
        "prompt_hash": _hash(user_prompt),
    }

    # ── Step 3: chain finishes, action is taken ───────────────────────────────
    action_taken_at = _now()
    output_hash = _hash(chain_output)
    print(f"[{action_taken_at}] Chain completed — output hash: {output_hash[:16]}...")
    print()

    # ── Certify with full timing breakdown ────────────────────────────────────
    timing: TimingBreakdown = {
        "instruction_received_at": instruction_received_at,
        "reasoning_started_at": reasoning_started_at,
        "action_taken_at": action_taken_at,
        # "instruction_following": a human sent the prompt → human is accountable
        "jurisdiction_type": "instruction_following",
    }

    cert = client.certify_with_confidence(
        file_hash=output_hash,
        file_name="langchain-summary.json",
        author="langchain-timing-demo",
        confidence_level=0.90,
        threshold_stage="final",
        decision_id=f"langchain-summary-{output_hash[:8]}",
        reversibility_class="reversible",
        who="langchain-timing-demo",
        what=output_hash,
        when=action_taken_at,
        why=_hash(user_prompt),
        timing=timing,
    )

    print("── Certification ───────────────────────────────────────────────────")
    print(f"  Proof ID:        {cert.id}")
    print(f"  Transaction:     {cert.transaction_hash or '(pending)'}")
    print(f"  Blockchain:      {cert.blockchain_status}")
    if cert.timing_breakdown:
        tb = cert.timing_breakdown
        print()
        print("── Timing breakdown (echoed by server) ─────────────────────────────")
        print(f"  instruction_received_at: {tb.get('instruction_received_at', '—')}")
        print(f"  reasoning_started_at:    {tb.get('reasoning_started_at', '—')}")
        print(f"  action_taken_at:         {tb.get('action_taken_at', '—')}")
        print(f"  jurisdiction_type:       {tb.get('jurisdiction_type', '—')}")
        if tb.get("reasoning_duration_ms") is not None:
            print(f"  reasoning_duration_ms:   {tb['reasoning_duration_ms']} ms")
        if tb.get("total_duration_ms") is not None:
            print(f"  total_duration_ms:       {tb['total_duration_ms']} ms")

    print()
    print("Decision chronology is permanently anchored on MultiversX.")


if __name__ == "__main__":
    main()
