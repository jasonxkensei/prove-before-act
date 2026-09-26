"""AutoGen + xProof: automatic message certification between agents.

Demonstrates how to attach xProof hooks to AutoGen agents so that every
message exchanged is certified on-chain with 4W metadata (WHO, WHAT,
WHEN, WHY) on MultiversX.

Run: python main.py

Requirements:
    pip install prove-before-act[autogen]
    # The xproof module name below is a legacy compatibility alias.

This demo simulates two agents exchanging messages with xProof hooks
attached, certifying each message on-chain.  It uses mock objects for
the xProof client so no real API key or LLM backend is required.
"""

from unittest.mock import MagicMock

from xproof.integrations.autogen import register_xproof_hooks


class FakeAgent:
    """Minimal stand-in for autogen.ConversableAgent."""

    def __init__(self, name: str):
        self.name = name
        self._hooks: dict = {}

    def register_hook(self, hookable_method: str, hook):
        self._hooks.setdefault(hookable_method, []).append(hook)

    def _run_hooks(self, hookable_method: str, message):
        for hook in self._hooks.get(hookable_method, []):
            message = hook(message)
        return message

    def receive(self, message: str, sender: "FakeAgent"):
        return self._run_hooks("process_last_received_message", message)

    def send(self, message: str, recipient: "FakeAgent"):
        message = self._run_hooks("process_message_before_send", message)
        recipient.receive(message, sender=self)
        return message


def main():
    mock_client = MagicMock()
    mock_client.certify_hash.return_value = MagicMock(
        id="proof-001", file_hash="abc", transaction_hash="tx-001"
    )

    alice = FakeAgent("alice")
    bob = FakeAgent("bob")

    register_xproof_hooks(alice, client=mock_client, agent_name="alice")
    register_xproof_hooks(bob, client=mock_client, agent_name="bob")

    print("=== Two-Agent Conversation with xProof Certification ===\n")

    alice.send("Hi Bob, can you summarise the Q3 earnings report?", bob)
    print("[alice -> bob] Hi Bob, can you summarise the Q3 earnings report?")

    bob.send("Sure! Q3 revenue was $4.2M, up 15% YoY.", alice)
    print("[bob -> alice] Sure! Q3 revenue was $4.2M, up 15% YoY.")

    alice.send("Thanks! Can you break that down by region?", bob)
    print("[alice -> bob] Thanks! Can you break that down by region?")

    bob.send("North America: $2.1M, Europe: $1.3M, Asia: $0.8M.", alice)
    print("[bob -> alice] North America: $2.1M, Europe: $1.3M, Asia: $0.8M.")

    total_calls = mock_client.certify_hash.call_count
    print(f"\nTotal certify_hash calls: {total_calls}")
    print("(Each send triggers a 'message_sent' cert on the sender,")
    print(" and each receive triggers a 'message_received' cert on the receiver.)")

    print("\nSample certification metadata:")
    for i, call in enumerate(mock_client.certify_hash.call_args_list[:4], 1):
        meta = call.kwargs["metadata"]
        print(f"  {i}. {meta['action_type']} by {meta['who']}")


if __name__ == "__main__":
    main()
