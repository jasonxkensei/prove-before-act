"""DeerFlow + xProof: certify agent outputs on the blockchain.

Demonstrates how a DeerFlow agent can use the XProofDeerFlowSkill
to certify its outputs on-chain with 4W metadata.

Run: python main.py

Requirements:
    pip install prove-before-act[deerflow]
    # The xproof module name below is a legacy compatibility alias.
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
    print(f"   proof_id: {parsed['proof_id']}")
    print(f"   file_hash: {parsed['file_hash']}")
    print(f"   status: {parsed['status']}")

    print("\n2. Certify with metadata:")
    result = skill._run(
        json.dumps(
            {
                "content": "Market analysis: AI sector growing 40% annually",
                "file_name": "market-analysis.json",
                "author": "market-analyst",
                "why": "Annual market review certification",
            }
        )
    )
    parsed = json.loads(result)
    print(f"   proof_id: {parsed['proof_id']}")
    print(f"   transaction_hash: {parsed['transaction_hash']}")
    print(f"   status: {parsed['status']}")

    print("\n3. Certification metadata from last call:")
    call_kwargs = mock_client.certify_hash.call_args.kwargs
    meta = call_kwargs["metadata"]
    print(f"   who: {meta['who']}")
    print(f"   what: {meta['what'][:16]}...")
    print(f"   when: {meta['when']}")
    print(f"   why: {meta['why']}")
    print(f"   framework: {meta['framework']}")

    print(f"\nTotal certifications: {mock_client.certify_hash.call_count}")


if __name__ == "__main__":
    main()
