"""Trading agent + xProof: confidence-level anchoring on MultiversX.

A trading agent anchors its reasoning at different confidence thresholds,
creating a forensic trail that proves the decision was real-time — not
reconstructed after the fact.

  60% → initial signal detected
  80% → pre-commitment, ready to act
 100% → final decision, trade executed

All three anchors share the same decision_id, so anyone can retrieve the
full chain and verify the agent's reasoning progression.

Install:
    pip install prove-before-act>=0.2.2
    # The xproof module name below is a legacy compatibility alias.

Run:
    python main.py

Production usage:
    from xproof import XProofClient

    client = XProofClient(api_key="pm_...")
    client.certify_with_confidence(
        file_hash=sha256_of_your_analysis,
        file_name="analysis.json",
        author="my-trading-agent",
        confidence_level=0.6,
        threshold_stage="initial",
        decision_id="trade-AAPL-2025-01-15-001",
    )
"""

import hashlib
import json
import uuid
from datetime import datetime, timezone

from xproof import XProofClient


def sha256(data: str) -> str:
    return hashlib.sha256(data.encode()).hexdigest()


def main():
    client = XProofClient.register("trading-confidence-demo")
    print(f"Registered: {client.registration.api_key[:12]}...")
    print(f"Trial remaining: {client.registration.trial.remaining}")
    print()

    decision_id = f"trade-AAPL-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{uuid.uuid4().hex[:8]}"
    print(f"Decision chain: {decision_id}")
    print("=" * 60)

    # ── Stage 1: Initial signal (60%) ─────────────────────────
    print("\n--- Stage 1: Initial signal (60% confidence) ---")

    analysis_1 = json.dumps({
        "ticker": "AAPL",
        "signal": "bullish_divergence",
        "rsi": 32.4,
        "macd_cross": True,
        "volume_spike": False,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    cert_1 = client.certify_with_confidence(
        file_hash=sha256(analysis_1),
        file_name="signal-detection.json",
        author="trading-confidence-demo",
        confidence_level=0.6,
        threshold_stage="initial",
        decision_id=decision_id,
        who="trading-confidence-demo",
        what=sha256(analysis_1),
        why="bullish_divergence detected on AAPL",
    )
    print(f"  Proof ID:    {cert_1.id}")
    print(f"  Hash:        {cert_1.file_hash[:16]}...")
    print(f"  Verify:      https://xproof.app/proof/{cert_1.id}")
    print(f"  Tx:          {cert_1.transaction_url}")

    # ── Stage 2: Pre-commitment (80%) ─────────────────────────
    print("\n--- Stage 2: Pre-commitment (80% confidence) ---")

    analysis_2 = json.dumps({
        "ticker": "AAPL",
        "signal": "bullish_divergence",
        "rsi": 34.1,
        "macd_cross": True,
        "volume_spike": True,
        "order_book_depth": "strong_bid_wall",
        "correlation_check": "sector_aligned",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    cert_2 = client.certify_with_confidence(
        file_hash=sha256(analysis_2),
        file_name="pre-commitment-analysis.json",
        author="trading-confidence-demo",
        confidence_level=0.8,
        threshold_stage="pre-commitment",
        decision_id=decision_id,
        who="trading-confidence-demo",
        what=sha256(analysis_2),
        why="volume confirmation + order book support",
    )
    print(f"  Proof ID:    {cert_2.id}")
    print(f"  Hash:        {cert_2.file_hash[:16]}...")
    print(f"  Verify:      https://xproof.app/proof/{cert_2.id}")
    print(f"  Tx:          {cert_2.transaction_url}")

    # ── Stage 3: Final decision (100%) ────────────────────────
    print("\n--- Stage 3: Final decision (100% confidence) ---")

    analysis_3 = json.dumps({
        "ticker": "AAPL",
        "action": "BUY",
        "size": 150,
        "entry_price": 198.42,
        "stop_loss": 195.50,
        "take_profit": 205.00,
        "risk_reward": 2.25,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    cert_3 = client.certify_with_confidence(
        file_hash=sha256(analysis_3),
        file_name="trade-execution.json",
        author="trading-confidence-demo",
        confidence_level=1.0,
        threshold_stage="final",
        decision_id=decision_id,
        who="trading-confidence-demo",
        what=sha256(analysis_3),
        why="all confirmations passed — executing BUY 150 AAPL @ 198.42",
    )
    print(f"  Proof ID:    {cert_3.id}")
    print(f"  Hash:        {cert_3.file_hash[:16]}...")
    print(f"  Verify:      https://xproof.app/proof/{cert_3.id}")
    print(f"  Tx:          {cert_3.transaction_url}")

    # ── Retrieve the full trail ───────────────────────────────
    print("\n" + "=" * 60)
    print("Retrieving confidence trail...")
    print("=" * 60)

    trail = client.get_confidence_trail(decision_id)
    print(f"\n  Decision ID:      {trail['decision_id']}")
    print(f"  Total anchors:    {trail['total_anchors']}")
    print(f"  Current stage:    {trail['current_stage']}")
    print(f"  Finalized:        {trail['is_finalized']}")
    print()

    for i, stage in enumerate(trail["stages"], 1):
        confidence = stage.get("confidence_level")
        pct = f"{int(confidence * 100)}%" if confidence is not None else "n/a"
        print(f"  [{i}] {pct:>4s}  {stage['threshold_stage']:<16s}  {stage['file_name']}")
    print()

    print("Full trail is publicly verifiable:")
    print(f"  https://xproof.app/api/confidence-trail/{decision_id}")
    print()
    print("This trail proves the agent's reasoning was real-time,")
    print("not reconstructed after the trade was executed.")


if __name__ == "__main__":
    main()
