"""LangChain BaseTool wrapper for one-line Prove Before Act decision certification."""

import asyncio
import hashlib
from datetime import datetime, timezone
from typing import Any, Optional, cast

try:
    from langchain_core.tools import BaseTool
    from pydantic.v1 import BaseModel, Field
except ImportError:
    try:
        from langchain.tools import BaseTool
        from pydantic import BaseModel, Field
    except ImportError as err:
        raise ImportError(
            "langchain is required for this integration. "
            "Install it with: pip install langchain-core"
        ) from err

from .client import XProofClient
from .exceptions import PolicyViolationError
from .models import Certification, ReversibilityClass


class _CertifyInput(BaseModel):  # type: ignore[misc]  # BaseModel is Any when langchain is not installed
    """Input schema for XProofCertifyTool.

    Mirrors the full parameter surface of
    :meth:`~xproof.XProofClient.certify_with_confidence` with one addition:
    ``decision_text`` is a convenience field whose SHA-256 hash is used as
    ``file_hash``.  Callers that already hold a pre-computed hash can pass it
    directly via ``file_hash`` and leave ``decision_text`` empty.
    """

    decision_text: str = Field(
        default="",
        description=(
            "The agent's reasoning or decision payload as a plain string. "
            "SHA-256 hashed automatically to produce file_hash. "
            "Leave empty if you supply file_hash directly."
        ),
    )
    file_hash: Optional[str] = Field(
        default=None,
        description=(
            "Pre-computed 64-char lowercase hex SHA-256 digest. "
            "If omitted, it is derived from decision_text."
        ),
    )
    confidence_level: float = Field(
        ...,
        description="Agent's self-assessed confidence between 0.0 and 1.0.",
    )
    threshold_stage: str = Field(
        default="pre-commitment",
        description=(
            "Stage in the decision lifecycle. "
            "One of: 'initial', 'partial', 'pre-commitment', 'final'."
        ),
    )
    decision_id: str = Field(
        ...,
        description="Shared identifier that links all proofs in the same decision chain.",
    )
    reversibility_class: Optional[str] = Field(
        default=None,
        description=(
            "Governance class: 'reversible', 'costly', or 'irreversible'. "
            "Irreversible actions require confidence_level >= 0.95."
        ),
    )
    file_name: Optional[str] = Field(
        default=None,
        description=("Label for the proof artifact. Defaults to '<decision_id>-<stage>.json'."),
    )
    who: Optional[str] = Field(
        default=None,
        description=(
            "4W metadata — agent identity. Defaults to the tool's author value when omitted."
        ),
    )
    what: Optional[str] = Field(
        default=None,
        description=(
            "4W metadata — action hash or description. Defaults to the SHA-256 hash when omitted."
        ),
    )
    when: Optional[str] = Field(
        default=None,
        description=(
            "4W metadata — ISO-8601 timestamp. Defaults to the current UTC time when omitted."
        ),
    )
    why: Optional[str] = Field(
        default=None,
        description="4W metadata — reason or instruction that triggered the decision.",
    )
    metadata: Optional[dict[str, Any]] = Field(
        default=None,
        description=(
            "Extra key-value pairs stored alongside the proof. "
            "Merged with the auto-generated 4W fields — caller keys take precedence."
        ),
    )
    author: Optional[str] = Field(
        default=None,
        description=(
            "Override the proof author for this specific call. "
            "Defaults to the tool-level author set at construction time."
        ),
    )


class XProofCertifyTool(BaseTool):  # type: ignore[misc]  # BaseTool is Any when langchain is not installed
    """LangChain tool that certifies an agent decision in one line.

    Wraps :meth:`~xproof.XProofClient.certify_with_confidence` and the
    subsequent :meth:`~xproof.XProofClient.get_policy_check` compliance gate
    into a single ``tool.run()`` call.  Accepts the full parameter surface of
    ``certify_with_confidence`` plus the ``decision_text`` convenience field.
    If the policy check fails the tool raises
    :class:`~xproof.exceptions.PolicyViolationError` so the agent or chain can
    catch and handle the violation — or let it propagate as a hard stop.

    Example::

        from xproof.langchain_tool import XProofCertifyTool

        certify = XProofCertifyTool(api_key="pm_...", author="my-agent")

        # Inside a LangChain agent or LCEL chain:
        result = certify.run({
            "decision_text": json.dumps(decision_payload),
            "confidence_level": 0.97,
            "threshold_stage": "pre-commitment",
            "decision_id": "run-2026-04-20",
            "reversibility_class": "irreversible",
            "why": "Scheduled GDPR data-retention cleanup",
        })
        # result is the transaction_hash — safe to proceed.
    """

    name: str = "xproof_certify"
    description: str = (
        "Certify an agent decision on-chain via xProof, then run the compliance gate. "
        "Returns the transaction hash when the policy check passes. "
        "Raises PolicyViolationError if the decision violates the governance policy."
    )
    args_schema: type[BaseModel] = _CertifyInput

    api_key: str = ""
    author: str = "langchain-agent"
    _client: Optional[XProofClient] = None

    def __init__(
        self,
        api_key: str = "",
        author: str = "langchain-agent",
        client: Optional[XProofClient] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(api_key=api_key, author=author, **kwargs)
        self._client = client or XProofClient(api_key=api_key)

    def _run(
        self,
        confidence_level: float,
        decision_id: str,
        decision_text: str = "",
        file_hash: Optional[str] = None,
        threshold_stage: str = "pre-commitment",
        reversibility_class: Optional[str] = None,
        file_name: Optional[str] = None,
        author: Optional[str] = None,
        who: Optional[str] = None,
        what: Optional[str] = None,
        when: Optional[str] = None,
        why: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> str:
        """Certify a decision and gate on the compliance check.

        Either ``decision_text`` (hashed automatically) or a pre-computed
        ``file_hash`` must be supplied; ``decision_text`` takes precedence.

        Args:
            confidence_level: Agent confidence between 0.0 and 1.0.
            decision_id: Shared ID linking proofs in the same decision chain.
            decision_text: Raw text hashed to produce ``file_hash``.
            file_hash: Pre-computed 64-char hex SHA-256.  Used only when
                ``decision_text`` is empty.
            threshold_stage: One of ``initial``, ``partial``,
                ``pre-commitment``, ``final``.
            reversibility_class: ``reversible``, ``costly``, or
                ``irreversible``.
            file_name: Artifact label (defaults to
                ``<decision_id>-<stage>.json``).
            author: Override the proof author for this call (defaults to
                the tool-level ``self.author``).
            who: 4W — agent identity (defaults to the resolved author).
            what: 4W — action description (defaults to the hash).
            when: 4W — ISO-8601 timestamp (defaults to current UTC time).
            why: 4W — reason for the decision.
            metadata: Extra key-value pairs stored with the proof.

        Returns:
            The on-chain ``transaction_hash`` when the policy check passes.

        Raises:
            ValueError: If neither ``decision_text`` nor ``file_hash`` is
                provided.
            PolicyViolationError: If ``get_policy_check`` reports one or
                more violations.
        """
        assert self._client is not None  # always set in __init__

        if decision_text:
            resolved_hash = hashlib.sha256(decision_text.encode()).hexdigest()
        elif file_hash:
            resolved_hash = file_hash
        else:
            raise ValueError("Either decision_text or file_hash must be provided.")

        resolved_author = author if author is not None else self.author
        artifact_name = file_name or f"{decision_id}-{threshold_stage}.json"
        resolved_who = who if who is not None else resolved_author
        resolved_what = what if what is not None else resolved_hash
        resolved_when = when if when is not None else datetime.now(timezone.utc).isoformat()

        cert: Certification = self._client.certify_with_confidence(
            file_hash=resolved_hash,
            file_name=artifact_name,
            author=resolved_author,
            confidence_level=confidence_level,
            threshold_stage=threshold_stage,
            decision_id=decision_id,
            who=resolved_who,
            what=resolved_what,
            when=resolved_when,
            why=why,
            reversibility_class=cast(Optional[ReversibilityClass], reversibility_class),
            metadata=metadata,
        )

        check = self._client.get_policy_check(decision_id)

        if not check.policy_compliant:
            violation_lines = [
                f"[POLICY VIOLATION] {v.rule} (proof_id={v.proof_id}, confidence_level={v.confidence_level}, threshold={v.threshold})"
                for v in check.policy_violations
            ]
            summary = "; ".join(violation_lines)
            raise PolicyViolationError(
                message=f"Policy compliance check failed for decision '{decision_id}': {summary}",
                decision_id=decision_id,
                violations=check.policy_violations,
            )

        return cert.transaction_hash

    async def _arun(
        self,
        confidence_level: float,
        decision_id: str,
        decision_text: str = "",
        file_hash: Optional[str] = None,
        threshold_stage: str = "pre-commitment",
        reversibility_class: Optional[str] = None,
        file_name: Optional[str] = None,
        author: Optional[str] = None,
        who: Optional[str] = None,
        what: Optional[str] = None,
        when: Optional[str] = None,
        why: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> str:
        """Async variant of :meth:`_run`.

        Executes the synchronous certification and policy-check logic in a
        thread pool via :func:`asyncio.to_thread` so it does not block the
        event loop.  Drop-in compatible with async LangChain / LCEL pipelines
        and async agent executors.

        Args and return value are identical to :meth:`_run`.

        Raises:
            ValueError: If neither ``decision_text`` nor ``file_hash`` is
                provided.
            PolicyViolationError: If ``get_policy_check`` reports one or
                more violations.
        """
        return await asyncio.to_thread(
            self._run,
            confidence_level=confidence_level,
            decision_id=decision_id,
            decision_text=decision_text,
            file_hash=file_hash,
            threshold_stage=threshold_stage,
            reversibility_class=reversibility_class,
            file_name=file_name,
            author=author,
            who=who,
            what=what,
            when=when,
            why=why,
            metadata=metadata,
        )
