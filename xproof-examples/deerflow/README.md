# DeerFlow + Prove Before Act

Add on-chain certification to DeerFlow agents via `XProofDeerFlowSkill`.

## What gets certified

Any content the agent passes to the skill — plain text or structured JSON — is certified with:
- **WHO** — your agent name
- **WHAT** — SHA-256 hash of the content
- **WHEN** — UTC timestamp
- **WHY** — your configured reason

## Install

```bash
pip install xproof
```

## Usage

```python
from xproof import XProofClient
from xproof.integrations.deerflow import XProofDeerFlowSkill

client = XProofClient(api_key="pm_...")   # get key at provebeforeact.com
skill = XProofDeerFlowSkill(client=client, agent_name="research-agent")

# The agent calls the skill to certify its output
result = skill._run("Q3 revenue grew 15% YoY driven by AI product adoption.")
print(result)  # JSON with proof_id, file_hash, transaction_hash, status
```

Structured JSON input with custom metadata:

```python
import json

result = skill._run(json.dumps({
    "content": "Market analysis: AI sector growing 40% annually",
    "file_name": "market-analysis.json",
    "author": "market-analyst",
    "why": "Annual market review certification",
}))
```

## Run the demo

```bash
python main.py
```

No API key required — the demo uses a mock Prove Before Act client.

## Links

- [provebeforeact.com](https://provebeforeact.com)
- Docs (LLM-readable): [provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt)
- [PyPI: Prove Before Act](https://pypi.org/project/xproof)
