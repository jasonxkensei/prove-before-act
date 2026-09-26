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
# The example itself only needs the SDK and its mock client.
pip install prove-before-act
python main.py
```

The example uses a mock client — no live API key or MultiversX node required.

> The published SDK no longer bundles a `fetchai` extra. The upstream Fetch.ai
> uAgents dependency currently pulls in `ecdsa`, which has no patched release
> for CVE-2024-23342. This integration remains available as source reference,
> but installing uAgents is intentionally left to consumers who have assessed
> that upstream dependency for their own environment.

## Real usage

```python
# `xproof` is the legacy module compatibility alias in the canonical
# prove-before-act distribution.
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
