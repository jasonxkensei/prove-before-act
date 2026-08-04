# Prove Before Act PR Descriptions — Ready to Paste

## PR 1 — bytedance/deer-flow

**Title:** `feat: add Prove Before Act blockchain certification skill`

**Body:**

---

### Add Prove Before Act blockchain certification skill

Adds `xproof_certify` as a native DeerFlow skill that certifies agent outputs on the [MultiversX](https://multiversx.com) blockchain — creating immutable, publicly verifiable proofs of work.

#### What it does

1. Agent invokes `xproof_certify` with its output content
2. The skill hashes the content (SHA-256), attaches 4W metadata (Who, What, When, Why), and submits to the Prove Before Act API
3. Prove Before Act anchors the hash on MultiversX mainnet and returns a `proof_id` and `transaction_hash`
4. The proof can be independently verified at any time — no trust in the agent required

#### Why this matters for DeerFlow

DeerFlow agents produce research, analysis, and recommendations that downstream systems rely on. Without a tamper-proof record, there is no way to verify *what* an agent produced, *when* it produced it, or *who* was responsible.

Prove Before Act's 4W framework solves this:

| Field | Meaning |
|-------|---------|
| **WHO** | Agent identity |
| **WHAT** | SHA-256 hash of the output |
| **WHEN** | Blockchain timestamp (chain-written, not agent-declared) |
| **WHY** | Context or instruction that produced the output |

#### Integration surface

- Skill definition: `skills/xproof.yaml` (standard YAML frontmatter)
- Python implementation: `pip install xproof` → `XProofDeerFlowSkill`
- Zero DeerFlow core changes — uses the standard skill interface
- Also works via the LangChain callback handler (DeerFlow uses LangGraph internally)

#### Files

| File | Purpose |
|------|---------|
| `skills/xproof.yaml` | DeerFlow skill definition |
| `examples/xproof/main.py` | Demo script (runs with mock objects) |
| `examples/xproof/README.md` | Usage documentation |
| `examples/xproof/requirements.txt` | Python dependencies |

#### Links

- [Prove Before Act](https://provebeforeact.com) · [API docs](https://provebeforeact.com/docs) · [Python SDK](https://pypi.org/project/xproof/) · [GitHub](https://github.com/jasonxkensei/xProof) · [MCP endpoint](https://provebeforeact.com/mcp)

---

---

## PR 2 — openai/openai-agents-python

**Title:** `feat: add Prove Before Act blockchain certification hooks`

**Body:**

---

### Add Prove Before Act on-chain certification for OpenAI Agents SDK

Adds two integration classes that automatically certify agent and tool outputs on the [MultiversX](https://multiversx.com) blockchain using the Prove Before Act 4W framework (Who, What, When, Why).

#### Components

**`XProofRunHooks`** — extends `RunHooks`
- Certifies `on_tool_end` (every tool output) and `on_agent_end` (final agent response)
- Uses the runtime `agent.name` for the WHO field — no hardcoded identity
- Auto-flushes buffered certifications when the agent completes
- Supports batch mode for cost efficiency

**`XProofTracingProcessor`** — implements `TracingProcessor`
- Certifies completed spans of type `tool` and `agent`
- Integrates with `add_trace_processor()` — zero agent code changes
- Skips non-actionable spans (LLM, handoff) to avoid noise

#### Why this matters

AI agents that make decisions and take actions need accountability. Prove Before Act provides a tamper-proof audit trail: each certification anchors a SHA-256 hash on MultiversX with structured 4W metadata.

| Field | On-chain |
|-------|----------|
| **WHO** | Agent identity (from `agent.name`) |
| **WHAT** | SHA-256 hash of the output |
| **WHEN** | Blockchain timestamp (chain-written) |
| **WHY** | Action type (`tool_execution`, `agent_completion`) |

The result is a verifiable claim that an agent produced a specific output at a specific time — independently auditable by anyone with the `proof_id`.

#### Usage

```python
from agents import Agent, Runner
from xproof.integrations.openai_agents import XProofRunHooks

hooks = XProofRunHooks(api_key="pm_...")
agent = Agent(name="analyst", instructions="You analyze data.")
result = await Runner.run(agent, input="Analyze Q3 metrics", hooks=hooks)
```

#### Files

| File | Purpose |
|------|---------|
| `examples/xproof/main.py` | Demo with RunHooks and TracingProcessor (mock objects) |
| `examples/xproof/README.md` | Usage documentation |
| `examples/xproof/requirements.txt` | Dependencies: `openai-agents>=0.0.3`, `xproof>=0.1.0` |

#### Links

- [Prove Before Act](https://provebeforeact.com) · [API docs](https://provebeforeact.com/docs) · [Python SDK](https://pypi.org/project/xproof/) · [GitHub](https://github.com/jasonxkensei/xProof) · [MCP endpoint](https://provebeforeact.com/mcp)

---

---

## PR 3 — microsoft/autogen

**Title:** `feat: add Prove Before Act blockchain certification hooks for AutoGen agents`

**Body:**

---

### Add Prove Before Act on-chain certification for AutoGen agents

Adds message-level certification hooks that automatically anchor every message exchanged between AutoGen agents on the [MultiversX](https://multiversx.com) blockchain using the Prove Before Act 4W framework (Who, What, When, Why).

#### Components

**`register_xproof_hooks(agent, ...)`** — one-line setup
- Registers `process_message_before_send` and `process_last_received_message` hooks
- Each message is SHA-256 hashed and certified with 4W metadata
- Hooks are transparent — messages flow through unchanged
- Supports batch mode for multi-agent conversations

**`XProofConversableAgent`** — subclass of `ConversableAgent`
- Pre-wired with Prove Before Act hooks for tighter integration
- Same behavior as `register_xproof_hooks` but with a single class

#### Why this matters

AutoGen enables multi-agent conversations where agents negotiate, delegate, and produce outputs. But without a tamper-proof record, there is no way to audit *what was said*, *by whom*, and *when*.

Prove Before Act makes every message in a conversation independently verifiable:

| Field | On-chain |
|-------|----------|
| **WHO** | Agent name |
| **WHAT** | SHA-256 hash of the message content |
| **WHEN** | Blockchain timestamp (chain-written) |
| **WHY** | `message_sent` or `message_received` |

Any message in the conversation can be independently verified by anyone with the `proof_id` — without trusting any of the participating agents.

#### Usage

```python
from autogen import ConversableAgent
from xproof.integrations.autogen import register_xproof_hooks

assistant = ConversableAgent("assistant", llm_config={"model": "gpt-4o"})
user_proxy = ConversableAgent("user_proxy", human_input_mode="NEVER")

register_xproof_hooks(assistant, api_key="pm_...")
register_xproof_hooks(user_proxy, api_key="pm_...")

user_proxy.initiate_chat(assistant, message="Summarize the Q3 earnings report.")
# Every message in the conversation is certified on-chain
```

#### Files

| File | Purpose |
|------|---------|
| `examples/xproof/main.py` | Two-agent conversation demo (mock objects) |
| `examples/xproof/README.md` | Usage documentation |
| `examples/xproof/requirements.txt` | Dependencies: `pyautogen>=0.2.0`, `xproof>=0.1.0` |

#### Links

- [Prove Before Act](https://provebeforeact.com) · [API docs](https://provebeforeact.com/docs) · [Python SDK](https://pypi.org/project/xproof/) · [GitHub](https://github.com/jasonxkensei/xProof) · [MCP endpoint](https://provebeforeact.com/mcp)

---

---

## PR 4 — run-llama/llama_index

**Title:** `feat: add Prove Before Act blockchain certification callback handler`

**Body:**

---

### Add Prove Before Act on-chain certification for LlamaIndex

Adds a callback handler that automatically certifies every LLM call, query completion, and tool invocation from a LlamaIndex pipeline on the [MultiversX](https://multiversx.com) blockchain using the Prove Before Act 4W framework (Who, What, When, Why).

#### Component

**`XProofCallbackHandler`** — extends LlamaIndex's callback system
- Hooks into `CBEventType.LLM`, `CBEventType.QUERY`, and `CBEventType.FUNCTION_CALL`
- Each event output is SHA-256 hashed and certified with 4W metadata
- Integrates via `CallbackManager` — zero pipeline code changes
- Supports batch mode with auto-flush at `end_trace`

#### Why this matters

LlamaIndex pipelines retrieve documents, call LLMs, and invoke tools to produce answers. Without a tamper-proof record, there is no way to verify *which* LLM was called, *what* it returned, or *when* it happened.

Prove Before Act makes every step in the pipeline independently verifiable:

| Field | On-chain |
|-------|----------|
| **WHO** | Agent/pipeline identity |
| **WHAT** | SHA-256 hash of the LLM response, query result, or tool output |
| **WHEN** | Blockchain timestamp (chain-written) |
| **WHY** | `llm_completion`, `query_completion`, or `function_call` |

Each certification produces a permanent `proof_id` and MultiversX `transaction_hash` — independently auditable by anyone.

#### Usage

```python
from llama_index.core.callbacks import CallbackManager
from xproof.integrations.llamaindex import XProofCallbackHandler

handler = XProofCallbackHandler(api_key="pm_...")
callback_manager = CallbackManager([handler])

query_engine = index.as_query_engine(callback_manager=callback_manager)
response = query_engine.query("What is AI?")
# LLM calls and query completions are automatically certified on-chain
```

#### Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `certify_llm` | `True` | Certify LLM call responses |
| `certify_query` | `True` | Certify query completions |
| `certify_function_call` | `True` | Certify tool/function call outputs |
| `batch_mode` | `False` | Buffer certifications, flush at end of trace |

#### Files

| File | Purpose |
|------|---------|
| `examples/xproof/main.py` | Pipeline simulation demo (uses trial API) |
| `examples/xproof/README.md` | Usage documentation |
| `examples/xproof/requirements.txt` | Dependencies: `llama-index-core>=0.10.0`, `xproof>=0.1.0` |

#### Links

- [Prove Before Act](https://provebeforeact.com) · [API docs](https://provebeforeact.com/docs) · [Python SDK](https://pypi.org/project/xproof/) · [GitHub](https://github.com/jasonxkensei/xProof) · [MCP endpoint](https://provebeforeact.com/mcp)

---
