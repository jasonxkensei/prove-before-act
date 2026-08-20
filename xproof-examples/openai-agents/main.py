"""OpenAI Agents SDK + xProof: certify tool executions and agent completions.

Two integration patterns:
  1. RunHooks          — per-run, hooks into on_tool_end and on_agent_end
  2. TracingProcessor  — global, processes every completed span

WHO attribution uses the runtime agent/tool name from the SDK objects,
not a static fallback — so each agent and tool is correctly identified.

The TracingProcessor supports both span types used by the OpenAI Agents SDK:
  - "function" — FunctionSpanData (local tool calls, the real SDK type)
  - "agent"    — AgentSpanData (agent lifecycle)

Install:
    pip install prove-before-act openai-agents
    # The xproof module name below is a legacy compatibility alias.

Run:
    python main.py

Production usage — RunHooks:
    from agents import Agent, Runner
    from xproof.integrations.openai_agents import XProofRunHooks

    hooks = XProofRunHooks(api_key="pm_...")
    result = await Runner.run(agent, input="...", hooks=hooks)

Production usage — TracingProcessor (zero agent code changes):
    from agents.tracing import add_trace_processor
    from xproof.integrations.openai_agents import XProofTracingProcessor

    add_trace_processor(XProofTracingProcessor(api_key="pm_..."))
"""

import asyncio
from unittest.mock import MagicMock

from xproof.integrations.openai_agents import XProofRunHooks, XProofTracingProcessor


def make_mock_client():
    client = MagicMock()
    client.certify_hash.return_value = MagicMock(
        id="proof-oa-001",
        file_hash="abc123def456",
        transaction_hash="tx-mvx-001",
    )
    return client


def make_agent(name="research-agent"):
    agent = MagicMock()
    agent.name = name
    return agent


def make_tool(name="web_search"):
    tool = MagicMock()
    tool.name = name
    return tool


def make_span(span_type: str, name: str, output: str = ""):
    """Simulate a completed OpenAI Agents SDK span."""
    span = MagicMock()
    span_data = MagicMock()
    span_data.type = span_type
    span_data.name = name
    span_data.output = output
    span.span_data = span_data
    return span


async def demo_run_hooks():
    """Demo: XProofRunHooks certifying tool and agent lifecycle events."""
    print("=== RunHooks Demo ===\n")

    mock_client = make_mock_client()
    hooks = XProofRunHooks(
        client=mock_client,
        agent_name="fallback-agent",
        certify_tools=True,
        certify_agent=True,
    )

    agent = make_agent("research-agent")
    web_search = make_tool("web_search")
    summarize = make_tool("summarize")
    ctx = MagicMock()

    print("Tool 1: web_search")
    await hooks.on_tool_end(ctx, agent, web_search, "Q3 revenue: $4.2M, +15% YoY")
    print("  -> certified")

    print("Tool 2: summarize")
    await hooks.on_tool_end(ctx, agent, summarize, "Strong Q3 driven by AI product growth.")
    print("  -> certified")

    print("Agent completion")
    await hooks.on_agent_end(ctx, agent, "Final report delivered.")
    print("  -> certified")

    print(f"\nTotal certify_hash calls: {mock_client.certify_hash.call_count}")
    print("\nSample metadata (tool 1):")
    first_call = mock_client.certify_hash.call_args_list[0]
    meta = first_call.kwargs["metadata"]
    print(f"  who:    {meta['who']}")
    print(f"  when:   {meta['when']}")
    print(f"  why:    {meta['why']}")
    print(f"  framework: {meta['framework']}")


def demo_tracing_processor():
    """Demo: XProofTracingProcessor certifying spans by type."""
    print("\n=== TracingProcessor Demo ===\n")

    mock_client = make_mock_client()
    processor = XProofTracingProcessor(
        client=mock_client,
        agent_name="fallback-agent",
        certify_tool_spans=True,
        certify_agent_spans=True,
    )

    print("Span type='function' (local tool call — real SDK type):")
    span1 = make_span("function", "web_search", "Q3 revenue: $4.2M")
    processor.on_span_end(span1)
    print("  -> certified with WHO=web_search")

    print("\nSpan type='tool' (also accepted for compatibility):")
    span2 = make_span("tool", "calculator", "42")
    processor.on_span_end(span2)
    print("  -> certified with WHO=calculator")

    print("\nSpan type='agent' (agent lifecycle):")
    span3 = make_span("agent", "research-agent", "Report complete.")
    processor.on_span_end(span3)
    print("  -> certified with WHO=research-agent")

    print("\nSpan type='unknown' (filtered out):")
    span4 = make_span("unknown", "other", "data")
    processor.on_span_end(span4)
    print("  -> skipped (not certified)")

    print(f"\nTotal certify_hash calls: {mock_client.certify_hash.call_count}")

    print("\nWHO attribution per certification:")
    for i, call in enumerate(mock_client.certify_hash.call_args_list, 1):
        meta = call.kwargs["metadata"]
        print(f"  {i}. who={meta['who']}  action={meta['action_type']}")


def main():
    asyncio.run(demo_run_hooks())
    demo_tracing_processor()
    print()
    print("In production, replace mock_client with XProofClient(api_key='pm_...')")
    print("and use real Agent, Runner, and add_trace_processor from openai-agents.")


if __name__ == "__main__":
    main()
