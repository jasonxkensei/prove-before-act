# Trading Agent + Prove Before Act: Confidence-Level Anchoring

Anchor trading decisions at different confidence thresholds to create a forensic trail that proves real-time reasoning — not post-hoc reconstruction.

## How it works

A trading agent processes market signals in stages. At each stage, it anchors a proof with its current confidence level:

| Stage | Confidence | What's anchored |
|-------|-----------|-----------------|
| `initial` | 60% | Raw signal detection (RSI divergence, MACD cross) |
| `pre-commitment` | 80% | Confirmed signal with volume and order book data |
| `final` | 100% | Trade execution with entry, stop-loss, take-profit |

All three proofs share the same `decision_id`, forming a verifiable chain on the MultiversX blockchain.

## Why this matters

Without confidence anchoring, an agent could claim it "predicted" a move after the fact. With Prove Before Act:

- Each reasoning step is anchored **before** the next step happens
- Timestamps are blockchain-verified, not self-reported
- Anyone can retrieve the full trail via `GET /api/confidence-trail/:decision_id`
- The progression from 60% to 100% proves the decision evolved in real-time

## Install

```bash
pip install xproof>=0.2.2
```

## Run the demo

```bash
python main.py
```

No API key required — registers a free trial account automatically.

## Production usage

```python
from xproof import XProofClient

client = XProofClient(api_key="pm_...")

# Anchor at each confidence threshold
client.certify_with_confidence(
    file_hash=sha256_of_analysis,
    file_name="signal-detection.json",
    author="my-trading-agent",
    confidence_level=0.6,
    threshold_stage="initial",
    decision_id="trade-AAPL-20250115-001",
    who="my-trading-agent",
    why="bullish_divergence detected",
)

# ... agent continues analyzing ...

client.certify_with_confidence(
    file_hash=sha256_of_confirmation,
    file_name="trade-execution.json",
    author="my-trading-agent",
    confidence_level=1.0,
    threshold_stage="final",
    decision_id="trade-AAPL-20250115-001",
    who="my-trading-agent",
    why="all confirmations passed — executing BUY",
)

# Retrieve the full trail
trail = client.get_confidence_trail("trade-AAPL-20250115-001")
print(trail["total_anchors"])   # 2
print(trail["is_finalized"])    # True
```

### TypeScript (npm SDK)

```typescript
import { XProofClient } from "@prove-before-act/sdk";

const client = new XProofClient({ apiKey: "pm_..." });

await client.certifyWithConfidence(
  sha256OfAnalysis,
  "signal-detection.json",
  "my-trading-agent",
  {
    confidenceLevel: 0.6,
    thresholdStage: "initial",
    decisionId: "trade-AAPL-20250115-001",
  },
);

const trail = await client.getConfidenceTrail("trade-AAPL-20250115-001");
console.log(trail.isFinalized); // true
```

## Valid threshold stages

| Stage | Description |
|-------|-------------|
| `initial` | First signal detected, low confidence |
| `partial` | Growing confidence, partial confirmation |
| `pre-commitment` | High confidence, ready to act |
| `final` | Decision made, action executed |

## Links

- [provebeforeact.com](https://provebeforeact.com)
- Docs (LLM-readable): [provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt)
- [PyPI: Prove Before Act](https://pypi.org/project/xproof)
- [npm: @prove-before-act/sdk](https://www.npmjs.com/package/@prove-before-act/sdk)
