# OpenAI Agents SDK + Prove Before Act

Certify tool executions and agent completions on-chain using the OpenAI Agents SDK.

Two integration styles are available — pick the one that fits your architecture.

## What gets certified

- **RunHooks**: every `on_tool_end` and `on_agent_end` event
- **TracingProcessor**: every completed `function` span (tool calls) and `agent` span

Both record the 4W framework: WHO = agent/tool name at runtime, WHAT = SHA-256 of the output, WHEN = UTC timestamp, WHY = action type.

> **Note on span types**: The OpenAI Agents SDK uses `type="function"` for local tool spans (`FunctionSpanData`), not `"tool"`. The `XProofTracingProcessor` handles both.

## Install

```bash
pip install xproof openai-agents
```

## Usage

### Option A — RunHooks (per-run)

```python
import asyncio
from agents import Agent, Runner
from xproof.integrations.openai_agents import XProofRunHooks

hooks = XProofRunHooks(api_key="pm_...")   # get key at provebeforeact.com
agent = Agent(name="analyst", instructions="You analyze financial data.")

result = await Runner.run(agent, input="Summarise Q3 earnings", hooks=hooks)
```

### Option B — TracingProcessor (global, zero agent code changes)

```python
from agents.tracing import add_trace_processor
from xproof.integrations.openai_agents import XProofTracingProcessor

add_trace_processor(XProofTracingProcessor(api_key="pm_..."))

# All subsequent Runner.run() calls are certified automatically
```

## Run the demo

```bash
python main.py
```

No API key or OpenAI key needed for the demo — runs entirely with simulated objects.

## Links

- [provebeforeact.com](https://provebeforeact.com)
- Docs (LLM-readable): [provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt)
- [PyPI: Prove Before Act](https://pypi.org/project/xproof)
- [OpenAI Agents SDK](https://github.com/openai/openai-agents-python)
