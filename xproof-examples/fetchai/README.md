# Prove Before Act + Fetch.ai uAgents

Anchor every uAgent decision on **MultiversX mainnet** before the action that follows it. Each certification records the 4W audit trail: **Who** acted, **What** was produced, **When** it happened, and **Why**.

## Why this matters

uAgents operate autonomously — they send messages, execute trades, and trigger smart contracts without a human in the loop. When a dispute or audit occurs, self-reported logs are not independent evidence.

Prove Before Act anchors the **WHY** (trigger + reasoning) on-chain *before* the action, and the **WHAT** (output) *after*. Both proofs share a `decision_id`, creating a verifiable confidence trail no one can retroactively alter.

## Quickstart

```bash
pip install xproof uagents
```

```python
from uagents import Agent, Context
from xproof.integrations.fetchai import XProofuAgentMiddleware, xproof_handler, wrap_agent

agent = Agent(name="research-agent", seed="your-seed-phrase")

# Create middleware once
xp = wrap_agent(agent, api_key="pm_...")  # get key at provebeforeact.com

# Wrap any message handler — zero changes to your logic
@agent.on_message(model=ResearchQuery)
@xproof_handler(xp, incoming_context="Research query received from peer")
async def handle_query(ctx: Context, sender: str, msg: ResearchQuery):
    response = await run_research(msg.topic)
    return response  # returned value is certified as WHAT
```

## Dual-certification pattern

```python
# One call creates a WHY+WHAT pair with shared decision_id
result = xp.certify_action(
    action_name="yield-research",
    inputs={"query": "USDC yield pools on Base"},
    outputs={"top_apy": 8.2, "pool": "Aave V3"},
    why="Peer agent requested yield analysis for rebalancing",
    confidence_level=0.94,
)

print(result["decision_id"])           # links WHY and WHAT
print(result["why_proof"]["proof_id"]) # on-chain before the action
print(result["what_proof"]["proof_id"])# on-chain after the action
```

## Manual certification

```python
import uuid

decision_id = str(uuid.uuid4())

# Before action — certify the trigger
why = xp.certify_incoming(
    message=incoming_msg,
    sender=ctx.sender,
    context="Market data query",
    decision_id=decision_id,
)

# ... agent logic ...

# After action — certify the output
what = xp.certify_outgoing(
    response=result,
    recipient=ctx.sender,
    context="Market data response",
    decision_id=decision_id,
    confidence_level=0.91,
)
```

## Run the demo

```bash
python main.py
```

No API key needed — the demo uses mocked responses. To certify on-chain for real, replace `XProofClient.register()` with `XProofClient(api_key="pm_...")` obtained from [provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt).

## 4W metadata recorded per proof

| Field | Value |
|-------|-------|
| **WHO** | Agent name (`research-agent`) |
| **WHAT** | SHA-256 hash of the message / response |
| **WHEN** | UTC timestamp at certification time |
| **WHY** | Context string describing the action |

## Links

- SDK: `pip install xproof`
- Docs (LLM-readable): [provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt)
- GitHub: [github.com/jasonxkensei/xProof](https://github.com/jasonxkensei/xProof)
