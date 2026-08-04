# LangChain + Prove Before Act Examples

Two standalone scripts show different Prove Before Act integration points for
LangChain agents.  Choose the one that matches your use case.

| Script | Integration | Best for |
|---|---|---|
| `main.py` | `XProofCallbackHandler` | Certifying every LLM call automatically |
| `certify_tool_demo.py` | `XProofCertifyTool` | Certifying a specific high-stakes decision |

## Setup

Run these commands from the `python-sdk/` directory:

```bash
pip install -e .              # install the Prove Before Act package in editable mode
```

Or, to pin to the example's locked dependencies (run from this directory):

```bash
pip install -r examples/langchain-chain/requirements.txt
```

---

## `main.py` — LLM-call certification via callback handler

`XProofCallbackHandler` hooks into LangChain's callback system so every
`on_llm_start` / `on_llm_end` event is automatically hashed and certified
on-chain.  No changes to your chain logic are required — just pass the
handler to your chain's `callbacks` parameter.

```bash
python main.py
```

The script will:

1. Register a trial Prove Before Act agent.
2. Simulate two LangChain LLM calls with the handler attached.
3. Flush the batch — both calls are certified on-chain in one round trip.
4. Verify each proof by ID and print the result.

Each proof is anchored on MultiversX and verifiable at
`https://provebeforeact.com/verify/<proofId>`.

---

## `certify_tool_demo.py` — Decision certification via tool

`XProofCertifyTool` collapses the hash → certify → policy-check → gate
loop into a single `tool.run()` call.  Use it when an agent must certify
a specific decision (not every LLM turn) before executing an irreversible
action.

The demo uses the canonical **GDPR PII-deletion scenario**:

- **Action:** `delete_pii_records`
- **Scope:** `eu-region`
- **Count:** `15_000` records
- `confidence_level: 0.97`, `threshold_stage: "pre-commitment"`,
  `reversibility_class: "irreversible"`
- `why: "Scheduled GDPR retention cleanup"`

```bash
python certify_tool_demo.py
```

The script runs two scenarios back-to-back — no API key or network access
required (the client is mocked):

1. **Compliant** (confidence 0.97) — policy passes, deletion is allowed to
   proceed; the transaction hash is printed.
2. **Blocked** (confidence 0.82) — policy violated, `PolicyViolationError`
   is raised with a structured rule message and the deletion is aborted.

This scenario mirrors the CrewAI and AutoGen sections in
`examples/compliance_observability.py` so all three frameworks are
directly comparable.
