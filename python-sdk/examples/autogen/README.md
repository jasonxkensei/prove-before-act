# AutoGen + Prove Before Act Integration

Certify every message exchanged between AutoGen agents on-chain with 4W metadata.

## Installation

```bash
pip install xproof[autogen]
# or: pip install xproof pyautogen
```

## Quick Start

Register Prove Before Act hooks on any `ConversableAgent`. Every sent and received message is automatically certified on MultiversX.

```python
from autogen import ConversableAgent
from xproof.integrations.autogen import register_xproof_hooks

assistant = ConversableAgent("assistant", llm_config={"model": "gpt-4o"})
user_proxy = ConversableAgent("user_proxy", human_input_mode="NEVER")

register_xproof_hooks(assistant, api_key="pm_...")
register_xproof_hooks(user_proxy, api_key="pm_...")

user_proxy.initiate_chat(assistant, message="Summarize the Q3 earnings report.")
# Every message between agents is certified on-chain
```

## How It Works

`register_xproof_hooks` attaches two AutoGen hooks to the agent:

| Hook | Trigger | 4W Metadata |
|------|---------|-------------|
| `process_message_before_send` | Agent sends a message | WHO: agent name, WHAT: message hash, WHY: `message_sent` |
| `process_last_received_message` | Agent receives a message | WHO: agent name, WHAT: message hash, WHY: `message_received` |

Messages flow through normally — hooks are transparent and non-blocking.

## Batch Mode

```python
hooks = register_xproof_hooks(
    agent,
    api_key="pm_...",
    batch_mode=True,  # buffer certs, flush manually
)
hooks.flush()  # send all buffered certifications at once
```

## ConversableAgent Subclass

For tighter integration, use `XProofConversableAgent` which extends AutoGen's `ConversableAgent` with Prove Before Act hooks built in:

```python
from xproof.integrations.autogen import XProofConversableAgent

agent = XProofConversableAgent(
    "analyst",
    api_key="pm_...",
    llm_config={"model": "gpt-4o"},
)
```

## Running the Demo

```bash
pip install -r requirements.txt
python main.py
```

The demo simulates a two-agent conversation with mock objects — no API key or LLM backend needed.
