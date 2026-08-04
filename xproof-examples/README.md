# xproof-examples

Standalone examples showing how to certify AI agent outputs on the **MultiversX blockchain** using [Prove Before Act](https://provebeforeact.com).

Prove Before Act gives every agent action a tamper-proof audit trail anchored on-chain in ~6 seconds. Each certification records the **4W framework**: Who acted, What was produced, When it happened, and Why.

## Examples

| Framework | Language | Description |
|-----------|----------|-------------|
| [Trading Confidence](./trading-confidence/) | Python | Anchor decisions at 60%, 80%, 100% — forensic trail for trading agents |
| [LangChain](./langchain/) | Python | Certify every LLM call via a callback handler |
| [CrewAI](./crewai/) | Python | Certify each agent's task output in a multi-agent crew |
| [LlamaIndex](./llamaindex/) | Python | Certify LLM calls and query completions |
| [OpenAI Agents SDK](./openai-agents/) | Python | Certify tool executions and agent completions via RunHooks or TracingProcessor |
| [Vercel AI SDK](./vercel/) | TypeScript | Certify AI generations in a Next.js API route |
| [AutoGen](./autogen/) | Python | Certify messages exchanged between AutoGen agents |
| [DeerFlow](./deerflow/) | Python | Certify DeerFlow agent outputs via a skill |
| [Fetch.ai uAgents](./fetchai/) | Python | Anchor WHY+WHAT proofs for every uAgent message handler |
| [MultiversX SC MCP](./multiversx-mcp/) | Config | Certify SC deploy/upgrade/call operations via Claude Desktop with both MCPs side by side |

## Quick start

```bash
# Python frameworks
pip install xproof

# TypeScript / Vercel
npm install @prove-before-act/sdk
```

Get a free API key or start with the trial tier at **[provebeforeact.com](https://provebeforeact.com)**.

AI agents: read **[provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt)** — one page, machine-readable, register + certify in under 2 minutes.

## Links

- PyPI: [pypi.org/project/xproof](https://pypi.org/project/xproof)
- npm: [npmjs.com/package/@prove-before-act/sdk](https://www.npmjs.com/package/@prove-before-act/sdk)
- Docs (LLM-readable): [provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt)
- GitHub (SDK): [github.com/jasonxkensei/xProof](https://github.com/jasonxkensei/xProof)
