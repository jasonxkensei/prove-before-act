# CrewAI + Prove Before Act

Certify every agent's task output in a CrewAI crew with an on-chain audit trail.

## What gets certified

- **Per-task**: each `on_task_complete` produces one certification — WHO = agent role, WHY = task description
- **Crew-level**: one aggregate certification when the crew finishes

## Install

```bash
pip install xproof crewai
```

## Usage

### Option A — Crew callback (automatic, zero agent awareness)

```python
from xproof import XProofClient
from xproof.integrations.crewai import XProofCrewCallback

client = XProofClient(api_key="pm_...")
callback = XProofCrewCallback(client=client, crew_name="my-crew")

# Called after each CrewAI task finishes
result = callback.on_task_complete(
    agent_role="researcher",
    task_description="Analyse Q3 market data",
    output=task_output,
)
print(result["proof_id"])
```

### Option B — Explicit tool (agent-controlled)

```python
from xproof.integrations.crewai import XProofCertifyTool

tool = XProofCertifyTool(api_key="pm_...")

# Add to your CrewAI agent's tools list
agent = Agent(role="analyst", tools=[tool], ...)
```

## Run the demo

```bash
python main.py
```

No API key required — registers a free trial account automatically.

## Links

- [provebeforeact.com](https://provebeforeact.com)
- Docs (LLM-readable): [provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt)
- [PyPI: Prove Before Act](https://pypi.org/project/xproof)
