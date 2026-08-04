# Prove Before Act

[![Python SDK CI](https://github.com/jasonxkensei/xProof/actions/workflows/python-sdk.yml/badge.svg?branch=main)](https://github.com/jasonxkensei/xProof/actions/workflows/python-sdk.yml) [![PyPI version](https://img.shields.io/pypi/v/Prove Before Act)](https://pypi.org/project/xproof/) [![Python versions](https://img.shields.io/badge/python-3.9%20%7C%203.10%20%7C%203.11%20%7C%203.12-blue)](https://pypi.org/project/xproof/)

On-chain decision provenance for autonomous agents. **WHY before acting. WHAT after.** Timestamps written by the chain, not your agent.

```bash
pip install xproof
```

---

## 3 steps. 30 seconds.

### Step 1 — Register (no wallet, no payment)

```bash
curl -X POST https://provebeforeact.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "my-agent"}'
```

```json
{ "api_key": "pm_...", "trial": { "remaining": 10 } }
```

### Step 2 — Anchor WHY before acting

Hash your reasoning and certify it *before* your agent executes.

```bash
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_..." \
  -H "Content-Type: application/json" \
  -d '{
    "file_hash": "<sha256_of_reasoning>",
    "file_name": "reasoning.json",
    "author": "my-agent",
    "metadata": { "action_type": "decision" }
  }'
```

```json
{ "id": "why-proof-uuid", "transaction_hash": "0x..." }
```

### Step 3 — Anchor WHAT after acting

Hash your output and link it to the WHY proof.

```bash
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_..." \
  -H "Content-Type: application/json" \
  -d '{
    "file_hash": "<sha256_of_output>",
    "file_name": "output.json",
    "author": "my-agent",
    "metadata": { "action_type": "execution", "why_proof_id": "why-proof-uuid" }
  }'
```

```json
{ "id": "what-proof-uuid", "transaction_hash": "0x..." }
```

When something goes wrong, you don't guess. You verify.

---

## Python SDK

```python
from xproof import XProofClient, hash_string

# Register — zero-friction, no wallet, no payment
client = XProofClient.register("my-agent")
# 10 free certs, API key stored automatically

# Step 2: Anchor WHY before acting
why = client.certify_hash(
    file_hash=hash_string('{"action": "summarize", "model": "gpt-4"}'),
    file_name="reasoning.json",
    author="my-agent",
    metadata={"action_type": "decision"},
)

# Step 3: Anchor WHAT after acting
what = client.certify_hash(
    file_hash=hash_string(execution_output),
    file_name="output.json",
    author="my-agent",
    metadata={"action_type": "execution", "why_proof_id": why.id},
)

print(what.transaction_url)  # MultiversX explorer link
```

Or use an existing API key:

```python
client = XProofClient(api_key="pm_your_api_key")
```

---

## Framework Integrations

### LangChain

```python
from xproof.integrations.langchain import XProofCallbackHandler

handler = XProofCallbackHandler(api_key="pm_...")
llm = ChatOpenAI(callbacks=[handler])
```

### CrewAI

```python
from xproof.integrations.crewai import XProofListener

listener = XProofListener(api_key="pm_...")
```

### AutoGen

```python
from xproof.integrations.autogen import XProofHook

hook = XProofHook(api_key="pm_...")
agent.register_hook("process_last_received_message", hook.on_message)
```

### LlamaIndex

```python
from xproof.integrations.llamaindex import XProofCallbackHandler
from llama_index.core import Settings
from llama_index.core.callbacks import CallbackManager

Settings.callback_manager = CallbackManager([XProofCallbackHandler(api_key="pm_...")])
```

---

## 4W Framework (WHO / WHAT / WHEN / WHY)

Full accountability metadata on every certification:

```python
from xproof import XProofClient, hash_bytes

client = XProofClient(api_key="pm_your_key")

action_data = b'{"action": "generate_report", "model": "gpt-4"}'
action_hash = hash_bytes(action_data)

cert = client.certify_hash(
    file_hash=action_hash,
    file_name="agent-action.json",
    author="research-agent",
    who="erd1abc...or-agent-id",
    what=action_hash,
    when="2026-03-20T12:00:00Z",
    why=hash_bytes(b"Summarize Q1 earnings report"),
    metadata={"model": "gpt-4", "session_id": "sess-123"},
)
```

## Batch Certification

Certify up to 50 files in a single API call:

```python
results = client.batch_certify([
    {"file_hash": "abc123...", "file_name": "file1.pdf", "author": "my-agent"},
    {"file_hash": "def456...", "file_name": "file2.pdf"},
])

print(results.summary.total)    # 2
print(results.summary.created)  # 2
```

## Certify a Local File

```python
# Auto-hashes with SHA-256
cert = client.certify("path/to/report.pdf", author="my-agent")
print(cert.id)
print(cert.transaction_url)
```

## Verify a Proof

```python
# By proof ID
proof = client.verify("certification-uuid")
print(proof.file_name, proof.blockchain_status)

# By file hash
proof = client.verify_hash("e3b0c442...")
```

## Policy Compliance

Check whether a decision meets governance requirements — without fetching the full confidence trail:

```python
from xproof import XProofClient, PolicyCheckResult

client = XProofClient(api_key="pm_your_key")

result: PolicyCheckResult = client.get_policy_check("trade-xyz-2026")

if result.policy_compliant:
    print("Decision is compliant.")
else:
    for v in result.policy_violations:
        print(f"VIOLATION [{v.severity}] — {v.rule}")
        print(f"  {v.message}")
```

`get_policy_check()` is a lightweight yes/no compliance check. It returns `result.policy_compliant` (bool) and `result.policy_violations` (list). For the full audit trail including timestamps and intermediate confidence checkpoints, use `get_confidence_trail()` instead.

---

## Context Drift Detection

Detect when the execution context of an agent changed between proof stages — different model version, tool set, strategy, or operator scope:

```python
from xproof import XProofClient

client = XProofClient(api_key="pm_your_key")

drift = client.get_context_drift("trade-xyz-2026")

if drift.context_coherent:
    print(f"No drift detected (score={drift.drift_score:.2f})")
else:
    print(f"Drift detected! score={drift.drift_score:.2f}")
    print(f"  Drifted fields : {drift.fields_drifted}")
    print(f"  Stable fields  : {drift.fields_stable}")
    print(f"  Absent fields  : {drift.fields_absent}")

    for i, stage in enumerate(drift.stages):
        print(f"  Stage {i}: model={stage.model_hash}, tools={stage.tools_version}")
```

`get_context_drift()` returns a `ContextDrift` object with these fields:

| Field | Type | Description |
|---|---|---|
| `context_coherent` | `bool` | `True` if no drift detected across the chain |
| `drift_score` | `float` | `0.0` = fully coherent · `1.0` = total drift |
| `fields_drifted` | `list[str]` | Fields that changed at least once |
| `fields_stable` | `list[str]` | Fields present in all stages and unchanged |
| `fields_absent` | `list[str]` | Fields never populated in any stage |
| `stages` | `list[ContextDriftStage]` | Per-stage snapshots (`model_hash`, `tools_version`, `strategy_snapshot`, `operator_scope`) |
| `raw` | `dict` | Unmodified API response |

---

## Timing Breakdown

Anchor the full decision chronology on-chain so forensic auditors can distinguish real-time reasoning from post-hoc reconstruction. Pass a `TimingBreakdown` dict to `certify_with_confidence()`:

```python
from xproof import XProofClient, TimingBreakdown
import time

client = XProofClient(api_key="pm_your_key")

# Capture timestamps at each lifecycle event
instruction_ts = "2026-04-20T14:30:00Z"  # when the agent received the task
reasoning_ts   = "2026-04-20T14:30:01Z"  # when reasoning/planning started
action_ts      = "2026-04-20T14:30:05Z"  # when the action was executed

timing: TimingBreakdown = {
    "instruction_received_at": instruction_ts,
    "reasoning_started_at":    reasoning_ts,
    "action_taken_at":         action_ts,
    "jurisdiction_type":       "autonomous_inference",  # legal accountability class
}

cert = client.certify_with_confidence(
    file_hash="e3b0c44298fc1c149afb...",
    file_name="trade-decision.json",
    author="trading-agent",
    confidence_level=0.97,
    threshold_stage="pre-commitment",
    decision_id="trade-xyz-2026",
    reversibility_class="irreversible",
    timing=timing,
)

# The server echoes timing_breakdown with computed durations
tb = cert.timing_breakdown
if tb:
    print(f"Thinking time : {tb.get('reasoning_duration_ms')} ms")
    print(f"Total latency : {tb.get('total_duration_ms')} ms")
```

### jurisdiction_type

The `jurisdiction_type` field records the legal accountability classification for the decision:

| Value | Meaning |
|---|---|
| `instruction_following` | Agent executed an explicit human instruction — accountability follows the principal |
| `autonomous_inference` | Agent reached its own conclusion — agent and its operator bear primary accountability |
| `human_approved` | Agent recommended; a human explicitly approved — shared accountability |

```python
from xproof import JURISDICTION_TYPES

print(JURISDICTION_TYPES)
# ('instruction_following', 'autonomous_inference', 'human_approved')
```

### Reading timing_breakdown from a Certification

When the server echoes the timestamps it also computes:
- `reasoning_duration_ms` — milliseconds between `reasoning_started_at` and `action_taken_at`
- `total_duration_ms` — milliseconds between `instruction_received_at` and `action_taken_at`

```python
tb = cert.timing_breakdown      # TimingBreakdown | None
if tb is not None:
    print(tb["instruction_received_at"])   # "2026-04-20T14:30:00Z"
    print(tb["reasoning_duration_ms"])     # 4000
    print(tb["total_duration_ms"])         # 5000
```

---

## Governance & Policy Enforcement

Prove Before Act detects automatically when an agent acted with insufficient confidence on an irreversible action — and writes the evidence on-chain before you ever open an incident report.

### Mark decisions as reversible, costly, or irreversible

Add `reversibility_class` to any certified action. The server enforces a policy: **irreversible actions require `confidence_level >= 0.95`**. Anything below that threshold generates a policy violation anchored to the chain.

```python
# An agent is about to execute a trade it cannot undo.
# It certifies its reasoning at 0.72 confidence — below the 0.95 threshold.
cert = client.certify_with_confidence(
    file_hash=hash_string('{"action": "sell", "ticker": "AAPL", "qty": 500}'),
    file_name="trade-decision.json",
    author="trading-agent",
    confidence_level=0.72,           # Agent's self-assessed confidence
    threshold_stage="pre-commitment",
    decision_id="trade-xyz-2026",
    reversibility_class="irreversible",  # This action cannot be undone
)

# cert.reversibility_class == "irreversible"
# The server has recorded a policy violation: 0.72 < 0.95 required
```

### Check compliance — without fetching the full trail

```python
from xproof import XProofClient, PolicyCheckResult

check: PolicyCheckResult = client.get_policy_check("trade-xyz-2026")

if not check.policy_compliant:
    for v in check.policy_violations:
        print(f"VIOLATION [{v.severity}] — {v.rule}")
        print(f"  {v.message}")
        # → VIOLATION [error] — irreversible actions require confidence_level >= 0.95
        # →   confidence 0.72 is below the required threshold of 0.95
```

Prefer `get_policy_check()` when you only need a fast governance gate. It avoids fetching the full confidence trail, which is better reserved for post-incident review or detailed forensic analysis.

### Full confidence trail with policy result

```python
trail = client.get_confidence_trail("trade-xyz-2026")

print(trail.policy_compliant)        # False
print(len(trail.policy_violations))  # 1
print(trail.current_confidence)      # 0.72
print(trail.is_finalized)            # False — decision still open
```

### End-to-end agent example: document deletion with compliance gate

This example shows a realistic governance loop for an autonomous agent that is
about to permanently delete customer records — an irreversible action that
requires a confidence level of at least 0.95 before proceeding.

#### Option A — One-line LangChain tool (recommended for LangChain / LCEL agents)

If you are already running a LangChain or LCEL agent, drop in `XProofCertifyTool`
to collapse the four-step hash → certify → check → gate loop into a single
`tool.run()` call.

```python
import json
from xproof.langchain_tool import XProofCertifyTool
from xproof.exceptions import PolicyViolationError

certify = XProofCertifyTool(api_key="pm_...", author="data-hygiene-agent")

decision = {
    "action": "delete_pii_records",
    "scope": "eu-region",
    "count": 15_000,
}
decision_id = "del-run-2026-04-20"

try:
    tx_hash = certify.run({
        "decision_text": json.dumps(decision, sort_keys=True),
        "confidence_level": 0.97,
        "threshold_stage": "pre-commitment",
        "decision_id": decision_id,
        "reversibility_class": "irreversible",
        "why": "Scheduled GDPR retention cleanup",
    })
    print(f"Policy compliant — proceeding (tx: {tx_hash})")
    # delete_pii_records(decision["scope"])   # your execution here
except PolicyViolationError as exc:
    for v in exc.violations:
        print(f"BLOCKED [{v.severity.upper()}] {v.rule}: {v.message}")
    raise RuntimeError("Deletion aborted: policy compliance check failed.") from exc
```

The tool hashes `decision_text` with SHA-256, calls
`certify_with_confidence`, and immediately runs `get_policy_check`.
If the check passes it returns the `transaction_hash`; if it fails it raises
`PolicyViolationError` with the full list of violations attached.

The tool accepts every parameter that `certify_with_confidence` does —
`who`, `what`, `when`, `why`, `reversibility_class`, `metadata`, and per-call
`author` — so you retain full provenance control.  When `who`, `what`, or
`when` are omitted the tool supplies sensible defaults (resolved author, SHA-256
hash, current UTC timestamp respectively); explicitly passing any of them
overrides those defaults.  You can also pass a pre-computed `file_hash` instead
of `decision_text` if you have already hashed the payload externally.

**Async support:** `XProofCertifyTool` fully supports async LangChain pipelines.
`_arun` is implemented via `asyncio.to_thread`, so it is safe to use in async
LCEL chains and async agent executors without blocking the event loop:

```python
# Inside an async LCEL chain or async agent executor:
tx_hash = await certify.arun({
    "decision_text": json.dumps(decision, sort_keys=True),
    "confidence_level": 0.97,
    "threshold_stage": "pre-commitment",
    "decision_id": decision_id,
    "reversibility_class": "irreversible",
    "why": "Scheduled GDPR retention cleanup",
})
```

You can also bind the tool to a LangChain agent directly:

```python
from langchain.agents import initialize_agent, AgentType
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o")
agent = initialize_agent(
    tools=[certify],
    llm=llm,
    agent=AgentType.OPENAI_FUNCTIONS,
)
```

#### Option A — One-line CrewAI tool (recommended for CrewAI agents)

`XProofCrewCertifyTool` provides the same one-call certification loop for
CrewAI agents.  `XProofNativeCrewCertifyTool` wraps it as a native
`BaseTool` subclass so it can be added directly to a CrewAI agent's
`tools` list.

```python
import json
from xproof.integrations.crewai import XProofCrewCertifyTool
from xproof.exceptions import PolicyViolationError

certify = XProofCrewCertifyTool(api_key="pm_...", author="data-hygiene-agent")

decision = {
    "action": "delete_pii_records",
    "scope": "eu-region",
    "count": 15_000,
}
decision_id = "del-run-2026-04-20"

try:
    tx_hash = certify.run(
        decision_text=json.dumps(decision, sort_keys=True),
        confidence_level=0.97,
        threshold_stage="pre-commitment",
        decision_id=decision_id,
        reversibility_class="irreversible",
        why="Scheduled GDPR retention cleanup",
    )
    print(f"Policy compliant — proceeding (tx: {tx_hash})")
    # delete_pii_records(decision["scope"])   # your execution here
except PolicyViolationError as exc:
    for v in exc.violations:
        print(f"BLOCKED [{v.severity.upper()}] {v.rule}: {v.message}")
    raise RuntimeError("Deletion aborted: policy compliance check failed.") from exc
```

To attach it natively to a CrewAI `Agent`:

```python
from crewai import Agent
from xproof.integrations.crewai import XProofNativeCrewCertifyTool

certify_tool = XProofNativeCrewCertifyTool(
    api_key="pm_...", author="data-hygiene-agent"
)
agent = Agent(role="analyst", tools=[certify_tool], ...)
```

#### Option A — One-line AutoGen tool (recommended for AutoGen agents)

`xproof_certify_decision` is a plain callable with the same full loop —
hash → certify → policy check → gate — designed to be registered as a
function tool on any AutoGen `ConversableAgent`.

```python
import json
from xproof.integrations.autogen import xproof_certify_decision
from xproof.exceptions import PolicyViolationError

decision = {
    "action": "delete_pii_records",
    "scope": "eu-region",
    "count": 15_000,
}
decision_id = "del-run-2026-04-20"

try:
    tx_hash = xproof_certify_decision(
        decision_text=json.dumps(decision, sort_keys=True),
        confidence_level=0.97,
        threshold_stage="pre-commitment",
        decision_id=decision_id,
        reversibility_class="irreversible",
        why="Scheduled GDPR retention cleanup",
        author="data-hygiene-agent",
        api_key="pm_...",
    )
    print(f"Policy compliant — proceeding (tx: {tx_hash})")
    # delete_pii_records(decision["scope"])   # your execution here
except PolicyViolationError as exc:
    for v in exc.violations:
        print(f"BLOCKED [{v.severity.upper()}] {v.rule}: {v.message}")
    raise RuntimeError("Deletion aborted: policy compliance check failed.") from exc
```

You can also register it as a tool on an AutoGen agent so the LLM can
invoke it by name:

```python
from autogen import AssistantAgent, UserProxyAgent
from functools import partial
from xproof.integrations.autogen import xproof_certify_decision

# Bind api_key once; the agent passes the decision fields per call.
certify = partial(xproof_certify_decision, api_key="pm_...", author="analyst-agent")

assistant = AssistantAgent("analyst", llm_config={...})
user_proxy = UserProxyAgent("user_proxy", human_input_mode="NEVER")

assistant.register_for_llm(name="certify_decision", description="Certify a decision on-chain")(certify)
user_proxy.register_for_execution(name="certify_decision")(certify)
```

#### Option B — Manual four-step loop (framework-agnostic)

```python
import hashlib, json
from xproof import XProofClient

client = XProofClient(api_key="pm_...")

def hash_string(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

# ── Step 1: Agent produces its reasoning ─────────────────────────────────────
# (In a real LangChain / CrewAI / AutoGen agent, this would be the structured
# chain-of-thought or tool-call output produced just before execution.)

decision = {
    "action": "delete_pii_records",
    "scope": "eu-region",
    "count": 15_000,
}
decision_id = "del-run-2026-04-20"
reasoning_hash = hash_string(json.dumps(decision, sort_keys=True))

# ── Step 2: Certify BEFORE executing ─────────────────────────────────────────
# The agent self-assesses its confidence. Because the action is irreversible,
# the policy requires confidence_level >= 0.95.

cert = client.certify_with_confidence(
    file_hash=reasoning_hash,
    file_name="delete-decision.json",
    author="data-hygiene-agent",
    confidence_level=0.97,               # Agent is highly confident
    threshold_stage="pre-commitment",    # valid: "initial", "partial", "pre-commitment", "final"
    decision_id=decision_id,
    reversibility_class="irreversible",  # Deletion cannot be undone
)

# cert.transaction_hash is the on-chain anchor — written before any records move

# ── Step 3: Compliance gate ───────────────────────────────────────────────────
# Immediately check policy compliance. This is a lightweight call — it does NOT
# re-fetch the full trail. Gate the destructive action on the result.

check = client.get_policy_check(decision_id)

if not check.policy_compliant:
    # Policy violated — log every violation and abort.
    for v in check.policy_violations:
        print(f"BLOCKED [{v.severity.upper()}] {v.rule}")
        print(f"  {v.message}")
    raise RuntimeError("Deletion aborted: policy compliance check failed.")

# ── Step 4: Execute only when compliant ──────────────────────────────────────
print(f"Policy compliant — proceeding with deletion (cert: {cert.transaction_hash})")
# delete_pii_records(decision["scope"])   # your actual execution here
```

**What happens if the agent's confidence is too low?**

Drop `confidence_level` to `0.82` and the same gate blocks execution:

```python
cert = client.certify_with_confidence(
    ...
    confidence_level=0.82,           # Below the 0.95 irreversible threshold
    reversibility_class="irreversible",
)

check = client.get_policy_check(decision_id)

if not check.policy_compliant:
    for v in check.policy_violations:
        print(f"BLOCKED [{v.severity.upper()}] {v.rule}")
        # → BLOCKED [ERROR] irreversible actions require confidence_level >= 0.95
        print(f"  {v.message}")
        # →   confidence 0.82 is below the required threshold of 0.95

    raise RuntimeError("Deletion aborted: policy compliance check failed.")
```

The violation is written on-chain at certification time — before your code
ever reaches the gate — so the audit trail exists even if your agent crashes
between `certify_with_confidence` and `get_policy_check`.

### Observability — surfacing violations in dashboards

Raising a `RuntimeError` is enough to halt execution, but it gives your
observability stack nothing structured to alert on.  The pattern below emits a
machine-readable JSON log line for each violation and optionally fires a
webhook, so Datadog / Grafana / CloudWatch log-based alerts can pick up
violations without grepping free-form text.

```python
import json, logging, urllib.request
from xproof import XProofClient

logger = logging.getLogger("Prove Before Act.compliance")
logging.basicConfig(level=logging.INFO)

client = XProofClient(api_key="pm_...")

# Optional: set a webhook URL to receive violation payloads
VIOLATION_WEBHOOK_URL = None  # e.g. "https://hooks.example.com/compliance"

def _emit_violation(decision_id: str, violation) -> None:
    """Emit one structured log line and, optionally, a webhook call."""
    payload = {
        "event":       "policy_violation",
        "decision_id": decision_id,
        "rule":        violation.rule,
        "severity":    violation.severity,
        "message":     violation.message,
    }
    # ── Structured JSON log (ingested by Datadog / CloudWatch / Loki) ─────────
    logger.error(json.dumps(payload))

    # ── Optional webhook / alerting callback (best-effort) ───────────────────
    if VIOLATION_WEBHOOK_URL:
        try:
            body = json.dumps(payload).encode()
            req  = urllib.request.Request(
                VIOLATION_WEBHOOK_URL,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5):
                pass  # fire-and-forget; add retry logic as needed
        except Exception as exc:
            # Best-effort delivery — a webhook failure must NOT swallow the
            # compliance violation itself.  Log and continue to the raise below.
            logger.warning(json.dumps({"event": "webhook_error", "detail": str(exc)}))

check = client.get_policy_check(decision_id)

if not check.policy_compliant:
    for v in check.policy_violations:
        _emit_violation(decision_id, v)

    # ── Full audit trail for post-mortem / SIEM export ────────────────────────
    # get_confidence_trail() returns a ConfidenceTrail object containing every
    # certification event — confidence levels, timestamps, transaction hashes —
    # so you can attach the complete chain-of-evidence to an incident ticket or
    # ship it to your SIEM without a separate lookup.
    # trail.raw is the unmodified API response dict; use trail.stages for
    # programmatic access to individual ConfidenceTrailStage entries.
    # Note: redact sensitive fields from trail.raw before logging or exporting
    # to centralised logs / SIEM in production environments.
    trail = client.get_confidence_trail(decision_id)
    logger.error(json.dumps({
        "event":       "audit_trail",
        "decision_id": decision_id,
        "trail":       trail.raw,
    }))

    raise RuntimeError("Deletion aborted: policy compliance check failed.")
```

Each `logger.error(...)` call writes a single-line JSON object that log
shippers (Fluentd, the Datadog Agent, the CloudWatch agent) forward verbatim.
Create a log-based metric or alert on `event = "policy_violation"` to get
dashboard counts and threshold alerts with no extra instrumentation.

> **Runnable example** — `python-sdk/examples/compliance_observability.py` runs the full pattern with a mock client and verifies structured output. No API key needed.

#### Drop-in: CrewAI one-liner

`XProofCrewCertifyTool` wraps `certify_with_confidence` + `get_policy_check` into a single `run()` call. Replace the manual four-step loop with:

```python
from xproof.integrations.crewai import XProofCrewCertifyTool
from xproof.exceptions import PolicyViolationError

certify = XProofCrewCertifyTool(api_key="pm_...", author="compliance-agent")

try:
    result = certify.run(
        decision_text=json.dumps(decision),
        confidence_level=0.91,
        reversibility_class="irreversible",
        decision_id="trade-xyz-2026",
    )
except PolicyViolationError as exc:
    for v in exc.violations:
        _emit_violation("trade-xyz-2026", v)   # reuse _emit_violation from above
    raise RuntimeError("Action aborted: policy compliance check failed.") from exc
```

#### Drop-in: AutoGen one-liner

`xproof_certify_decision` is a plain callable — register it as a function tool on any `ConversableAgent` or call it directly:

```python
from xproof.integrations.autogen import xproof_certify_decision
from xproof.exceptions import PolicyViolationError

try:
    result = xproof_certify_decision(
        api_key="pm_...",
        decision_text=json.dumps(decision),
        confidence_level=0.91,
        reversibility_class="irreversible",
        decision_id="trade-xyz-2026",
        author="autogen-agent",
    )
except PolicyViolationError as exc:
    for v in exc.violations:
        _emit_violation("trade-xyz-2026", v)
    raise RuntimeError("Action aborted: policy compliance check failed.") from exc
```

Both tools write the violation evidence on-chain before raising — so the structured log and the chain anchor are always in sync.

### Three classes, one parameter

| `reversibility_class` | What it means | Policy threshold |
|---|---|---|
| `"reversible"` | Action can be undone (e.g. draft, preview) | None — any confidence accepted |
| `"costly"` | Undoable but expensive (e.g. API call, DB write) | None — any confidence accepted |
| `"irreversible"` | Cannot be undone (e.g. trade, deletion, send) | `confidence_level >= 0.95` required |

> The threshold is configured server-side (`IRREVERSIBLE_CONFIDENCE_THRESHOLD=0.95`). All violations are written on-chain and cannot be amended.

---

## Pricing

```python
pricing = client.get_pricing()
print(pricing.price_usd)  # e.g. 0.01
```

## API Reference

### `XProofClient(api_key=None, base_url="https://provebeforeact.com", timeout=30)`

| Parameter  | Type  | Default                |
|------------|-------|------------------------|
| `api_key`  | `str` | `None`                 |
| `base_url` | `str` | `"https://provebeforeact.com"` |
| `timeout`  | `int` | `30` (seconds)         |

### Methods

| Method | Description |
|--------|-------------|
| `XProofClient.register(agent_name)` | Register agent, get trial key |
| `certify(path, author, *, reversibility_class?, **fourW)` | Certify file (hashes locally) |
| `certify_hash(file_hash, file_name, author, *, reversibility_class?, **fourW)` | Certify by pre-computed hash |
| `certify_with_confidence(hash, name, author, confidence_level, threshold_stage, decision_id, *, reversibility_class?, **fourW)` | Certify with confidence + governance class |
| `batch_certify(files)` | Batch certify (up to 50) |
| `verify(proof_id)` | Look up by proof ID |
| `verify_hash(file_hash)` | Look up by file hash |
| `get_confidence_trail(decision_id)` | Full trail with `policy_compliant` + violations |
| `get_policy_check(decision_id)` | Lightweight compliance check — no full trail |
| `get_pricing()` | Get current pricing |

## Development

Install dev dependencies and run the checks locally:

```bash
pip install -e ".[dev]"

# Lint (ruff — catches unused imports, duplicate class definitions, and more)
make lint

# Type-check with mypy
make typecheck

# Unit tests (excludes live-API integration tests)
make test

# Lint + typecheck + test together
make check
```

### Pre-commit hooks

A pre-commit hook runs `mypy` automatically before every commit so type errors
are caught locally rather than in CI.

Run the one-time setup from the `python-sdk/` directory:

```bash
make install-hooks
# Equivalent (run from the repo root):
# pre-commit install --config python-sdk/.pre-commit-config.yaml
```

After that, every `git commit` will run `make typecheck`, which checks the
entire `Prove Before Act/` package with mypy. If mypy reports any errors the commit is
blocked until they are fixed.

To run the hooks manually against all files without committing (from the repo root):

```bash
pre-commit run --all-files --config python-sdk/.pre-commit-config.yaml
```

The linter is configured in `pyproject.toml` under `[tool.ruff]`. Rule `F811` will flag
duplicate top-level class definitions — the kind of silent overwrite that prompted this setup.

### VS Code setup

A `.vscode/settings.json` is included in this directory. It configures the
[Ruff extension](https://marketplace.visualstudio.com/items?itemName=charliermarsh.ruff)
as the default Python formatter and enables **format on save**, so unused imports are
removed and imports are sorted automatically every time you save a file.

Install the extension once and the settings take effect immediately:

```bash
code --install-extension charliermarsh.ruff
```

## Links

- [provebeforeact.com](https://provebeforeact.com) — dashboard & docs
- [npm SDK](https://www.npmjs.com/package/@prove-before-act/sdk) — `npm install @prove-before-act/sdk`
- [Examples](https://github.com/jasonxkensei/xproof-examples) — LangChain, CrewAI, AutoGen, LlamaIndex

## License

MIT
