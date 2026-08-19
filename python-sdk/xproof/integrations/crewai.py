"""CrewAI integration for automatic Prove Before Act certification."""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional, cast

try:
    from crewai.tools import BaseTool as CrewAIBaseTool
except ImportError:
    CrewAIBaseTool = None

from ..client import XProofClient
from ..exceptions import PolicyViolationError
from ..models import ReversibilityClass


def _hash_data(data: Any) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


class XProofCertifyTool:
    """Lightweight tool for explicit agent certification (no CrewAI dependency).

    Use this when you want agents to certify specific outputs without
    requiring the ``crewai`` package. For the native CrewAI ``BaseTool``
    wrapper, use :class:`XProofCrewTool` instead.

    Example::

        from xproof.integrations.crewai import XProofCertifyTool

        tool = XProofCertifyTool(api_key="pm_...")
        result = tool._run("My research findings")
    """

    name: str = "xproof_certify"
    description: str = (
        "Certify a piece of work on the blockchain. "
        "Input should be a JSON string with 'content' (the text to certify) "
        "and optionally 'file_name' (name for the certification)."
    )

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        agent_name: str = "crewai-agent",
    ) -> None:
        self.client = client or XProofClient(api_key=api_key)
        self.agent_name = agent_name

    def _run(self, input_text: str) -> str:
        try:
            data = json.loads(input_text)
        except json.JSONDecodeError:
            data = {"content": input_text}

        content = data.get("content", input_text)
        file_name = data.get("file_name", "agent-output.json")

        content_hash = _hash_data(content)

        cert = self.client.certify_hash(
            file_hash=content_hash,
            file_name=file_name,
            author=self.agent_name,
            who=self.agent_name,
            what=content_hash,
            when=datetime.now(timezone.utc).isoformat(),
            why="CrewAI agent certification",
        )

        return json.dumps(
            {
                "proof_id": cert.id,
                "file_hash": cert.file_hash,
                "transaction_hash": cert.transaction_hash,
                "status": "certified",
            }
        )


XProofTool = XProofCertifyTool


class XProofCrewCertifyTool:
    """Standalone CrewAI-compatible tool that runs the full certification loop.

    Wraps :meth:`~xproof.XProofClient.certify_with_confidence` and the
    subsequent :meth:`~xproof.XProofClient.get_policy_check` compliance gate
    into a single ``run()`` call — the CrewAI equivalent of LangChain's
    ``XProofCertifyTool``.

    This class works without the ``crewai`` package installed. For the native
    ``BaseTool`` subclass (required when adding to a CrewAI agent's ``tools``
    list), use :class:`XProofNativeCrewCertifyTool` instead.

    Example::

        from xproof.integrations.crewai import XProofCrewCertifyTool
        from xproof.exceptions import PolicyViolationError
        import json

        certify = XProofCrewCertifyTool(api_key="pm_...", author="data-hygiene-agent")

        decision = {"action": "delete_records", "scope": "inactive", "records": 4821}

        try:
            tx_hash = certify.run(
                decision_text=json.dumps(decision, sort_keys=True),
                confidence_level=0.97,
                threshold_stage="pre-commitment",
                decision_id="del-run-2026-04-20",
                reversibility_class="irreversible",
                why="Scheduled GDPR data-retention cleanup",
            )
            print(f"Policy compliant — proceeding (tx: {tx_hash})")
        except PolicyViolationError as exc:
            for v in exc.violations:
                print(f"BLOCKED [POLICY VIOLATION] {v.rule} (proof_id={v.proof_id}, confidence_level={v.confidence_level}, threshold={v.threshold})")
    """

    name: str = "xproof_certify_decision"
    description: str = (
        "Certify an agent decision on-chain via Prove Before Act using confidence metadata, "
        "then run the compliance gate. "
        "Returns the transaction hash when the policy check passes. "
        "Raises PolicyViolationError if the decision violates the governance policy."
    )

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        author: str = "crewai-agent",
    ) -> None:
        self.client = client or XProofClient(api_key=api_key)
        self.author = author

    def run(
        self,
        decision_text: str = "",
        file_hash: Optional[str] = None,
        confidence_level: float = 0.0,
        threshold_stage: str = "pre-commitment",
        decision_id: str = "",
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
            decision_text: Raw text hashed to produce ``file_hash``.
            file_hash: Pre-computed 64-char hex SHA-256.  Used only when
                ``decision_text`` is empty.
            confidence_level: Agent's self-assessed confidence between 0.0
                and 1.0.
            threshold_stage: One of ``initial``, ``partial``,
                ``pre-commitment``, ``final``.
            decision_id: Shared ID linking proofs in the same decision chain.
            reversibility_class: ``reversible``, ``costly``, or
                ``irreversible``.
            file_name: Artifact label (defaults to
                ``<decision_id>-<stage>.json``).
            author: Override the proof author for this call.
            who: 4W — agent identity (defaults to the resolved author).
            what: 4W — action description (defaults to the hash).
            when: 4W — ISO-8601 timestamp (defaults to current UTC time).
            why: 4W — reason for the decision.
            metadata: Extra key-value pairs stored with the proof.

        Returns:
            The on-chain ``transaction_hash`` when the policy check passes.

        Raises:
            ValueError: If neither ``decision_text`` nor ``file_hash`` is
                provided, or if ``decision_id`` is empty.
            PolicyViolationError: If ``get_policy_check`` reports one or
                more violations.
        """
        if not decision_id:
            raise ValueError("decision_id must be provided.")

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

        cert = self.client.certify_with_confidence(
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

        check = self.client.get_policy_check(decision_id)

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


if CrewAIBaseTool is not None:

    class XProofNativeCrewCertifyTool(CrewAIBaseTool):  # type: ignore[misc]  # CrewAIBaseTool is Any when crewai is not installed
        """Native CrewAI ``BaseTool`` for full-loop certification with confidence and policy gate.

        Requires the ``crewai`` package. Accepts a JSON string with the same
        fields as :class:`XProofCrewCertifyTool` and delegates to it.  Add
        this to a CrewAI agent's ``tools`` list so the LLM can call it by
        name.

        Example::

            from xproof.integrations.crewai import XProofNativeCrewCertifyTool

            certify_tool = XProofNativeCrewCertifyTool(
                api_key="pm_...", author="data-hygiene-agent"
            )
            agent = Agent(role="analyst", tools=[certify_tool])
        """

        name: str = "xproof_certify_decision"
        description: str = (
            "Certify an agent decision on-chain via Prove Before Act with confidence metadata, "
            "then run the compliance policy gate. "
            "Input: JSON string with fields: decision_text (str), confidence_level (float), "
            "decision_id (str), threshold_stage (str, default 'pre-commitment'), "
            "reversibility_class (str, optional), why (str, optional), "
            "file_hash (str, optional if decision_text provided). "
            "Returns the transaction hash when compliant. "
            "Raises PolicyViolationError if the policy check fails."
        )

        _certify_tool: Any = None

        def __init__(
            self,
            api_key: str = "",
            author: str = "crewai-agent",
            client: Optional[XProofClient] = None,
            **kwargs: Any,
        ) -> None:
            super().__init__(**kwargs)
            self._certify_tool = XProofCrewCertifyTool(
                api_key=api_key,
                client=client,
                author=author,
            )

        def _run(self, input_text: str) -> str:
            try:
                params: dict[str, Any] = json.loads(input_text)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    "XProofNativeCrewCertifyTool expects a JSON string with at least "
                    "'decision_text' (or 'file_hash'), 'confidence_level', and 'decision_id' fields. "
                    f"Received non-JSON input: {input_text!r}"
                ) from exc

            return cast(str, self._certify_tool.run(**params))


if CrewAIBaseTool is not None:

    class XProofCrewTool(CrewAIBaseTool):  # type: ignore[misc]  # CrewAIBaseTool is Any when crewai is not installed
        """Native CrewAI ``BaseTool`` for Prove Before Act certification.

        Requires the ``crewai`` package. Wraps :class:`XProofCertifyTool`
        so it integrates natively with CrewAI's tool system.

        Example::

            from xproof.integrations.crewai import XProofCrewTool

            tool = XProofCrewTool(api_key="pm_...", agent_name="researcher")
            # Add to a CrewAI agent's tools list
        """

        name: str = "xproof_certify"
        description: str = (
            "Certify a piece of work on the blockchain for accountability. "
            "Input: JSON with 'content' and optional 'file_name'."
        )

        _xproof_tool: Any = None

        def __init__(
            self, api_key: str = "", agent_name: str = "crewai-agent", **kwargs: Any
        ) -> None:
            super().__init__(**kwargs)
            self._xproof_tool = XProofCertifyTool(api_key=api_key, agent_name=agent_name)

        def _run(self, input_text: str) -> str:
            return str(self._xproof_tool._run(input_text))


class XProofCrewCallback:
    """Callback that auto-certifies CrewAI task and crew completions.

    Attach to a crew to automatically certify each agent's task output
    with 4W metadata (WHO=agent role, WHAT=output hash, WHEN=timestamp,
    WHY=task description).

    Example::

        from xproof.integrations.crewai import XProofCrewCallback

        callback = XProofCrewCallback(api_key="pm_...")

        # Call after each task completes
        callback.on_task_complete(
            agent_role="researcher",
            task_description="Research Q1 earnings",
            output="The Q1 earnings report shows...",
        )

        # Call when the full crew finishes
        callback.on_crew_complete(
            crew_name="research-crew",
            goal="Produce quarterly analysis",
            results={"summary": "..."},
        )
    """

    def __init__(
        self,
        api_key: str = "",
        client: Optional[XProofClient] = None,
        crew_name: str = "crewai-crew",
    ) -> None:
        self.client = client or XProofClient(api_key=api_key)
        self.crew_name = crew_name
        self.certifications: list[dict[str, Any]] = []

    def on_task_complete(
        self,
        agent_role: str,
        task_description: str,
        output: Any,
    ) -> dict[str, Any]:
        """Certify a completed task's output."""
        output_hash = _hash_data(output)
        cert = self.client.certify_hash(
            file_hash=output_hash,
            file_name=f"task-{agent_role}.json",
            author=agent_role,
            who=agent_role,
            what=output_hash,
            when=datetime.now(timezone.utc).isoformat(),
            why=task_description,
            metadata={
                "framework": "crewai",
                "crew_name": self.crew_name,
                "agent_role": agent_role,
                "task_description": task_description,
            },
        )

        record = {
            "agent_role": agent_role,
            "task_description": task_description,
            "proof_id": cert.id,
            "file_hash": cert.file_hash,
            "transaction_hash": cert.transaction_hash,
        }
        self.certifications.append(record)
        return record

    def on_crew_complete(
        self,
        crew_name: str,
        goal: str,
        results: Any,
    ) -> dict[str, Any]:
        """Certify the complete crew execution."""
        results_hash = _hash_data(
            {
                "crew_name": crew_name,
                "goal": goal,
                "results": results,
                "task_certifications": [c["proof_id"] for c in self.certifications],
            }
        )

        cert = self.client.certify_hash(
            file_hash=results_hash,
            file_name=f"crew-{crew_name}-complete.json",
            author=crew_name,
            who=crew_name,
            what=results_hash,
            when=datetime.now(timezone.utc).isoformat(),
            why=goal,
            metadata={
                "framework": "crewai",
                "crew_name": crew_name,
                "goal": goal,
                "task_count": len(self.certifications),
                "task_proof_ids": [c["proof_id"] for c in self.certifications],
            },
        )

        return {
            "crew_name": crew_name,
            "proof_id": cert.id,
            "file_hash": cert.file_hash,
            "transaction_hash": cert.transaction_hash,
            "tasks_certified": len(self.certifications),
        }
