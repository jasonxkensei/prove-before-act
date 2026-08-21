"""DeerFlow + xProof: certify agent outputs on the MultiversX blockchain.

The XProofDeerFlowSkill can be called by any DeerFlow agent to produce
a tamper-proof on-chain record of its output with 4W metadata:
  WHO  = agent name
  WHAT = SHA-256 hash of the content
  WHEN = UTC timestamp
  WHY  = configurable declared decision basis

Install:
    pip install prove-before-act
    # The xproof module name below is a legacy compatibility alias.

Run:
    python main.py

Production usage:
    from xproof import XProofClient
    from xproof.integrations.deerflow import XProofDeerFlowSkill

    client = XProofClient(api_key="pm_...")
    skill = XProofDeerFlowSkill(client=client, agent_name="research-agent")

    # The agent certifies its output
    result = skill._run("Q3 revenue grew 15% YoY driven by AI adoption.")
    print(result)  # JSON: proof_id, file_hash, transaction_hash, status
"""

import json
from unittest.mock import MagicMock

from xproof.integrations.deerflow import XProofDeerFlowSkill


def main():
    mock_client = MagicMock()
    mock_client.certify_hash.return_value = MagicMock(
        id="proof-df-001",
        file_hash="abc123def456",
        transaction_hash="tx-mvx-789",
    )

    skill = XProofDeerFlowSkill(client=mock_client, agent_name="research-agent")

    print("=== DeerFlow xProof Skill Demo ===\n")

    print("1. Certify plain text:")
    result = skill._run("The Q3 revenue report shows $4.2M, up 15% YoY.")
    parsed = json.loads(result)
    print(f"   proof_id:  {parsed['proof_id']}")
    print(f"   file_hash: {parsed['file_hash']}")
    print(f"   status:    {parsed['status']}")
    print(f"   verify:    https://xproof.app/verify/{parsed['proof_id']}")

    print("\n2. Certify with custom metadata:")
    result = skill._run(json.dumps({
        "content": "Market analysis: AI sector growing 40% annually",
        "file_name": "market-analysis.json",
        "author": "market-analyst",
        "why": "Annual market review certification",
    }))
    parsed = json.loads(result)
    print(f"   proof_id:          {parsed['proof_id']}")
    print(f"   transaction_hash:  {parsed['transaction_hash']}")
    print(f"   status:            {parsed['status']}")

    print("\n3. Certification metadata (4W framework):")
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    meta = call_kwargs["metadata"]
    print(f"   who:       {meta['who']}")
    print(f"   what:      {meta['what'][:16]}...")
    print(f"   when:      {meta['when']}")
    print(f"   why:       {meta['why']}")
    print(f"   framework: {meta['framework']}")

    print(f"\nTotal certifications: {mock_client.certify_hash.call_count}")
    print()
    print("In production, replace mock_client with XProofClient(api_key='pm_...')")


if __name__ == "__main__":
    main()
