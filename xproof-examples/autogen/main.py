"""AutoGen + xProof: certify every message exchanged between agents.

Each send and receive is certified with 4W metadata:
  WHO  = agent name (sender or receiver)
  WHAT = SHA-256 hash of the message
  WHEN = UTC timestamp
  WHY  = "message_sent" or "message_received"

Install:
    pip install prove-before-act pyautogen
    # The xproof module name below is a legacy compatibility alias.

Run:
    python main.py

Production usage:
    from autogen import ConversableAgent
    from xproof import XProofClient
    from xproof.integrations.autogen import register_xproof_hooks

    client = XProofClient(api_key="pm_...")
    alice = ConversableAgent(name="alice", ...)
    bob   = ConversableAgent(name="bob", ...)

    register_xproof_hooks(alice, client=client, agent_name="alice")
    register_xproof_hooks(bob,   client=client, agent_name="bob")

    alice.initiate_chat(bob, message="Summarise the Q3 earnings report.")
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

    print()
    print("In production, replace mock_client with XProofClient(api_key='pm_...')")
    print("and swap FakeAgent for autogen.ConversableAgent.")


if __name__ == "__main__":
    main()
