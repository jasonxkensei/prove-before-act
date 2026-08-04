# Fetch.ai uAgents + Prove Before Act

Demonstrates on-chain proof anchoring for Fetch.ai uAgent messages using
`XProofuAgentMiddleware`.

## Patterns covered

| Pattern | Description |
|---|---|
| `certify_incoming` | Anchor an incoming message as a WHY proof |
| `certify_outgoing` | Anchor an outgoing response as a WHAT proof |
| Runtime toggle | Disable / re-enable certification without rebuilding the middleware |
| Batch mode | Accumulate proofs and flush them in a single `batch_certify` call |

## Run

```bash
pip install xproof
python main.py
```

The example uses a mock client — no live API key or MultiversX node required.

## Real usage

```python
from xproof import XProofClient
from xproof.integrations.fetchai import XProofuAgentMiddleware

client = XProofClient(api_key="xp_...")
middleware = XProofuAgentMiddleware(client=client, agent_name="my-agent")

# In your uAgent handler:
@agent.on_message(model=MyRequest)
async def handle(ctx: Context, sender: str, msg: MyRequest):
    middleware.certify_incoming(
        message=msg.dict(),
        sender=sender,
        context="Request received",
    )
    response = process(msg)
    middleware.certify_outgoing(
        response=response.dict(),
        recipient=sender,
        context="Response sent",
    )
    await ctx.send(sender, response)
```

## Toggle certification at runtime

```python
# Pause certification (e.g. during maintenance)
middleware.certify_incoming = False
middleware.certify_outgoing = False

# Re-enable when ready
middleware.certify_incoming = True
middleware.certify_outgoing = True
```
