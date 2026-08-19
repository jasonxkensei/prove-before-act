"""DeerFlow native skill integration for Prove Before Act certification.

Provides ``XProofDeerFlowSkill`` — a skill class following DeerFlow's
tool interface (``name``, ``description``, ``_run(input)``) that
certifies agent outputs on-chain using the Prove Before Act 4W framework
(Who, What, When, Why).

DeerFlow (bytedance/deer-flow) is an extensible super-agent harness.
Adding Prove Before Act as a native skill means any DeerFlow agent can certify
its outputs with a single skill invocation.
"""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional

from ..client import XProofClient


def _hash_data(data: Any) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


class XProofDeerFlowSkill:
    """DeerFlow skill that certifies content on the blockchain.

    Follows DeerFlow's ``BaseTool``-style interface with ``name``,
    ``description``, and ``_run(input)`` method.

    The input can be either a plain string (the content to certify) or
    a JSON string with the following optional fields:

    - ``content`` — the text to certify (required).
    - ``file_name`` — name for the certification record.
    - ``author`` — override the default agent name.
    - ``why`` — reason / context for the certification.

    Example::

        from xproof.integrations.deerflow import XProofDeerFlowSkill

        skill = XProofDeerFlowSkill(api_key="pm_...")
        result = skill._run("My research findings")
        print(result)  # JSON with proof_id, file_hash, transaction_hash
    """

    name: str = "xproof_certify"
    description: str = (
        "Certify a piece of content on the MultiversX blockchain for "
        "proof-of-existence and accountability. Input: plain text or "
        "JSON with 'content', optional 'file_name', 'author', 'why'."
    )

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        agent_name: str = "deerflow-agent",
    ) -> None:
        self.client = client or XProofClient(api_key=api_key)
        self.agent_name = agent_name

    def _run(self, input_text: Any) -> str:
        """Certify the input content and return a JSON result.

        Args:
            input_text: Plain text content, a JSON string, or a dict
                with ``content``, optional ``file_name``, ``author``,
                ``why``.

        Returns:
            JSON string with ``proof_id``, ``file_hash``,
            ``transaction_hash``, and ``status``.
        """
        if isinstance(input_text, dict):
            data = input_text
        elif isinstance(input_text, str):
            try:
                data = json.loads(input_text)
            except (json.JSONDecodeError, TypeError):
                data = {"content": input_text}
        else:
            data = {"content": str(input_text)}

        content = data.get("content", input_text)
        file_name = data.get("file_name", "deerflow-output.json")
        author = data.get("author", self.agent_name)
        why = data.get("why", "DeerFlow agent certification")

        content_hash = _hash_data(content)

        cert = self.client.certify_hash(
            file_hash=content_hash,
            file_name=file_name,
            author=author,
            metadata={
                "who": author,
                "what": content_hash,
                "when": datetime.now(timezone.utc).isoformat(),
                "why": why,
                "action_type": "skill_certification",
                "framework": "deerflow",
            },
        )

        return json.dumps(
            {
                "proof_id": cert.id,
                "file_hash": cert.file_hash,
                "transaction_hash": cert.transaction_hash,
                "status": "certified",
            }
        )
