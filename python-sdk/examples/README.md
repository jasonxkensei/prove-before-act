# Prove Before Act Python SDK — Examples

End-to-end examples showing how to anchor AI agent decisions on-chain with
Prove Before Act across the most popular agent frameworks.

## Quick start — no API key required

The fastest way to see Prove Before Act in action is the LangChain tool demo, which
runs entirely with mocked responses so you can explore the certification
flow without any credentials:

```bash
cd langchain-chain
pip install -r requirements.txt
python certify_tool_demo.py
```

When you are ready to write real proofs to MultiversX, replace the mock
client with your registered API key (see the
[langchain-chain README](langchain-chain/README.md) for details).

## Examples at a glance

| Directory / file | Integration class(es) | Description |
|---|---|---|
| [`langchain-chain/`](langchain-chain/README.md) | `XProofCallbackHandler`, `XProofCertifyTool` | Callback handler (`main.py`) and certify-tool demo (`certify_tool_demo.py`) — two integration patterns for LangChain agents |
| [`crewai-crew/`](crewai-crew/README.md) | `XProofCrewCertifyTool`, `XProofCrewCallback` | 3-agent crew (researcher, writer, reviewer) with per-agent on-chain certification |
| [`autogen/`](autogen/README.md) | `XProofAutoGenHooks` | Certifies every message exchanged between AutoGen agents with 4W metadata |
| [`llamaindex/`](llamaindex/README.md) | `XProofCallbackHandler` | Certifies LLM calls, queries, and tool invocations from a LlamaIndex pipeline |
| [`openai-agents/`](openai-agents/README.md) | `XProofRunHooks`, `XProofTracingProcessor` | Certifies tool calls and agent completions; self-contained, no extra sub-modules |
| [`fetchai/`](fetchai/README.md) | `XProofuAgentMiddleware` | On-chain proof anchoring for Fetch.ai uAgent messages |
| [`deerflow/`](deerflow/README.md) | `XProofDeerFlowSkill` | Prove Before Act as a DeerFlow skill — blockchain-anchored proof for any DeerFlow agent output |
| [`compliance_observability.py`](compliance_observability.py) | `XProofClient` (core SDK) | Standalone script demonstrating compliance logging and observability patterns |

## Choosing the right example

- **New to Prove Before Act?** Start with `langchain-chain/certify_tool_demo.py` — no
  framework knowledge required and it runs offline.
- **Building a multi-agent system?** See `crewai-crew/` or `autogen/`.
- **Using a RAG pipeline?** See `llamaindex/`.
- **Deploying autonomous agents?** See `fetchai/` or `deerflow/`.
- **Strict compliance requirements?** See `compliance_observability.py` for
  audit-trail and reversibility-class patterns.

Each subdirectory contains its own `README.md` with installation instructions,
a walkthrough of the code, and the canonical `delete_pii_records` / `eu-region`
scenario used throughout the Prove Before Act documentation.
