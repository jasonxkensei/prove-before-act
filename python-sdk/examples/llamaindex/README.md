# LlamaIndex + Prove Before Act Integration

Certify every LLM call, query, and tool invocation from your LlamaIndex pipeline on-chain.

## Installation

```bash
pip install xproof[llamaindex]
# or: pip install xproof llama-index-core
```

## Quick Start

```python
from llama_index.core.callbacks import CallbackManager
from xproof.integrations.llamaindex import XProofCallbackHandler
# Also available as: from xproof.integrations import XProofLlamaIndexHandler

handler = XProofCallbackHandler(api_key="pm_...")
callback_manager = CallbackManager([handler])

# Attach to any query engine
query_engine = index.as_query_engine(callback_manager=callback_manager)
response = query_engine.query("What is AI?")
# LLM calls and query completions are automatically certified on-chain
```

## Batch Mode

```python
handler = XProofCallbackHandler(
    api_key="pm_...",
    batch_mode=True,  # buffer certs, flush at end of trace
)
```

## Configuration Flags

- `certify_llm` (default: True) — certify LLM calls
- `certify_query` (default: True) — certify query completions
- `certify_function_call` (default: True) — certify tool/function calls

## Running the Demo

```bash
python main.py
```
