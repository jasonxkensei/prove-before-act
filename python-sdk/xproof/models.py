"""Data models for the Prove Before Act SDK."""

from dataclasses import dataclass, field
from typing import Any, Literal, Optional, TypedDict, Union

ReversibilityClass = Literal["reversible", "costly", "irreversible"]

JurisdictionType = Literal["instruction_following", "autonomous_inference", "human_approved"]
"""Legal accountability classification for an agent decision.

- ``instruction_following``: The agent executed an explicit instruction from a
  human or upstream system — accountability follows the principal.
- ``autonomous_inference``: The agent reached its own conclusion without an
  explicit instruction — agent (and its operator) bears primary accountability.
- ``human_approved``: The agent recommended an action and a human explicitly
  approved it before execution — shared accountability.
"""

JURISDICTION_TYPES: tuple[str, ...] = (
    "instruction_following",
    "autonomous_inference",
    "human_approved",
)
"""Tuple of all valid :data:`JurisdictionType` values — useful for runtime validation."""


class TimingBreakdown(TypedDict, total=False):
    """Decomposed decision timeline for forensic audit.

    Pass a ``TimingBreakdown`` to :meth:`~xproof.XProofClient.certify_with_confidence`
    via the ``timing`` parameter to anchor the full decision chronology on-chain.

    All fields are optional and ISO8601 date-time strings with timezone offset
    (e.g. ``"2026-04-20T14:31:58Z"``).

    When read back from the API via a :class:`~xproof.Certification` or a
    :class:`~xproof.ConfidenceTrailStage`, two additional computed fields are
    included:

    - ``reasoning_duration_ms`` — milliseconds between *reasoning_started_at*
      and *action_taken_at* (the verifiable "thinking time").
    - ``total_duration_ms`` — milliseconds between *instruction_received_at*
      and *action_taken_at*.
    """

    instruction_received_at: str
    reasoning_started_at: str
    action_taken_at: str
    jurisdiction_type: JurisdictionType
    reasoning_duration_ms: Optional[int]
    total_duration_ms: Optional[int]


class _CertifyEntryRequired(TypedDict):
    file_hash: str
    file_name: str


class CertifyEntry(_CertifyEntryRequired, total=False):
    """Typed shape for a hash-based entry passed to certify_hash or batch_certify.

    All integration modules produce this shape.  ``file_hash`` must be a
    64-character hex-encoded SHA-256 digest.  ``file_name`` is also required;
    ``author``, ``metadata``, and ``timing`` are optional.
    """

    author: str
    metadata: dict[str, Any]
    timing: TimingBreakdown


class PathCertifyEntry(TypedDict, total=False):
    """Typed shape for a path-based batch entry (legacy / advanced use).

    Pass ``path`` to let the SDK hash the file itself.  ``file_name`` defaults
    to the file's base name; ``author`` and ``metadata`` are optional extras.
    """

    path: str
    file_name: str
    author: str
    metadata: dict[str, Any]


BatchFileEntry = Union[CertifyEntry, PathCertifyEntry]
"""Union of all entry shapes accepted by :meth:`XProofClient.batch_certify`."""


@dataclass
class ContextDriftStage:
    """Per-stage context snapshot from a context-drift check."""

    proof_id: str
    context_break: bool = False
    drifted_fields: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ContextDriftStage":
        return cls(
            proof_id=data.get("proof_id", ""),
            context_break=data.get("context_break", False),
            drifted_fields=data.get("drifted_fields", []),
            raw=data,
        )


@dataclass
class ContextDrift:
    """Context drift analysis result for a decision chain."""

    decision_id: str = ""
    context_coherent: bool = True
    drift_score: float = 0.0
    fields_drifted: list[str] = field(default_factory=list)
    fields_stable: list[str] = field(default_factory=list)
    fields_absent: list[str] = field(default_factory=list)
    stages: list[ContextDriftStage] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ContextDrift":
        """Create a ContextDrift from an API response dictionary."""
        return cls(
            decision_id=data.get("decision_id", ""),
            context_coherent=data.get("context_coherent", True),
            drift_score=data.get("drift_score", 0.0),
            fields_drifted=data.get("fields_drifted", []),
            fields_stable=data.get("fields_stable", []),
            fields_absent=data.get("fields_absent", []),
            stages=[ContextDriftStage.from_dict(s) for s in data.get("stages", [])],
            raw=data,
        )


@dataclass
class PolicyViolation:
    """A single policy violation detected by the server.

    Matches the shape returned by ``GET /api/confidence-trail/{id}`` and
    ``GET /api/proofs/policy-check``:

    - ``proof_id`` — the certification that triggered the violation
    - ``confidence_level`` — confidence at which the proof was anchored
    - ``reversibility_class`` — governance class of the action
    - ``threshold_stage`` — decision stage (initial / partial / pre-commitment / final)
    - ``threshold`` — minimum confidence required (e.g. 0.95 for irreversible)
    - ``rule`` — machine-readable rule identifier
    """

    proof_id: str
    confidence_level: Optional[float]
    reversibility_class: str
    threshold_stage: Optional[str]
    threshold: float
    rule: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PolicyViolation":
        return cls(
            proof_id=data.get("proof_id", ""),
            confidence_level=data.get("confidence_level"),
            reversibility_class=data.get("reversibility_class", ""),
            threshold_stage=data.get("threshold_stage"),
            threshold=float(data.get("threshold", 0.0)),
            rule=data.get("rule", ""),
        )


@dataclass
class ConfidenceTrailStage:
    """One stage anchor in a confidence trail."""

    proof_id: str
    confidence_level: float
    threshold_stage: str
    reversibility_class: Optional[str] = None
    anchored_at: str = ""
    transaction_hash: str = ""
    transaction_url: str = ""
    policy_violations: list[PolicyViolation] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ConfidenceTrailStage":
        metadata = data.get("metadata", {})
        violations_raw = data.get("policy_violations", [])
        return cls(
            proof_id=data.get("proof_id", data.get("id", "")),
            confidence_level=data.get("confidence_level", metadata.get("confidence_level", 0.0)),
            threshold_stage=data.get("threshold_stage", metadata.get("threshold_stage", "")),
            reversibility_class=data.get(
                "reversibility_class", metadata.get("reversibility_class")
            ),
            anchored_at=data.get("anchored_at", data.get("created_at", "")),
            transaction_hash=data.get("transaction_hash", ""),
            transaction_url=data.get("transaction_url", ""),
            policy_violations=[PolicyViolation.from_dict(v) for v in violations_raw],
        )


@dataclass
class ConfidenceTrail:
    """Full confidence trail for a decision chain."""

    decision_id: str
    total_anchors: int = 0
    current_confidence: float = 0.0
    current_stage: str = ""
    is_finalized: bool = False
    policy_compliant: bool = True
    policy_violations: list[PolicyViolation] = field(default_factory=list)
    stages: list[ConfidenceTrailStage] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ConfidenceTrail":
        """Create a ConfidenceTrail from an API response dictionary."""
        stages = [ConfidenceTrailStage.from_dict(s) for s in data.get("stages", [])]
        violations_raw = data.get("policy_violations", [])
        return cls(
            decision_id=data.get("decision_id", ""),
            total_anchors=data.get("total_anchors", len(stages)),
            current_confidence=data.get("current_confidence", 0.0),
            current_stage=data.get("current_stage", ""),
            is_finalized=data.get("is_finalized", False),
            policy_compliant=data.get("policy_compliant", True),
            policy_violations=[PolicyViolation.from_dict(v) for v in violations_raw],
            stages=stages,
            raw=data,
        )


@dataclass
class PolicyCheckResult:
    """Lightweight governance compliance report for a decision chain."""

    decision_id: str
    total_anchors: int = 0
    policy_compliant: bool = True
    policy_violations: list[PolicyViolation] = field(default_factory=list)
    checked_at: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PolicyCheckResult":
        """Create a PolicyCheckResult from an API response dictionary."""
        violations_raw = data.get("policy_violations", [])
        return cls(
            decision_id=data.get("decision_id", ""),
            total_anchors=data.get("total_anchors", 0),
            policy_compliant=data.get("policy_compliant", True),
            policy_violations=[PolicyViolation.from_dict(v) for v in violations_raw],
            checked_at=data.get("checked_at", ""),
            raw=data,
        )


@dataclass
class CoherenceLinkResult:
    """Result of closing the WHY→WHAT coherence loop via POST /api/coherence/link."""

    success: bool = False
    already_linked: bool = False
    coherence_check_id: str = ""
    why_proof_id: str = ""
    linked_proof_id: Optional[str] = None
    intent_hash: str = ""
    coherence_score: Optional[int] = None
    created_at: Optional[str] = None
    score_breakdown: dict[str, Any] = field(default_factory=dict)
    message: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CoherenceLinkResult":
        """Create a CoherenceLinkResult from an API response dictionary."""
        cc = data.get("coherence_check") or {}
        return cls(
            success=data.get("success", False),
            already_linked=data.get("already_linked", False),
            coherence_check_id=cc.get("id", ""),
            why_proof_id=cc.get("why_proof_id", ""),
            linked_proof_id=cc.get("linked_proof_id"),
            intent_hash=cc.get("intent_hash", ""),
            coherence_score=cc.get("coherence_score"),
            created_at=cc.get("created_at"),
            score_breakdown=data.get("score_breakdown") or {},
            message=data.get("message", ""),
            raw=data,
        )


@dataclass
class Certification:
    """Represents a blockchain-anchored certification."""

    id: str
    file_name: str
    file_hash: str
    transaction_hash: str
    transaction_url: str
    created_at: str
    author_name: str = ""
    file_type: str = ""
    file_size: int = 0
    blockchain_status: str = ""
    is_public: bool = True
    certificate_url: str = ""
    verify_url: str = ""
    reversibility_class: Optional[str] = None
    timing_breakdown: Optional[TimingBreakdown] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Certification":
        """Create a Certification from an API response dictionary."""
        blockchain = data.get("blockchain", {})
        metadata = data.get("metadata", {})

        raw_timing: Optional[dict[str, Any]] = data.get(
            "timing_breakdown", metadata.get("timing_breakdown")
        )
        if not raw_timing:
            _TIMING_FLAT_KEYS = frozenset(
                (
                    "instruction_received_at",
                    "reasoning_started_at",
                    "action_taken_at",
                    "jurisdiction_type",
                    "reasoning_duration_ms",
                    "total_duration_ms",
                )
            )
            if any(k in metadata for k in _TIMING_FLAT_KEYS):
                raw_timing = metadata
        timing: Optional[TimingBreakdown] = None
        if raw_timing and isinstance(raw_timing, dict):
            tb: TimingBreakdown = {}
            for key in (
                "instruction_received_at",
                "reasoning_started_at",
                "action_taken_at",
                "jurisdiction_type",
                "reasoning_duration_ms",
                "total_duration_ms",
            ):
                if key in raw_timing and raw_timing[key] is not None:
                    tb[key] = raw_timing[key]
            timing = tb if tb else None

        return cls(
            id=data.get("id", data.get("proof_id", "")),
            file_name=data.get("fileName", data.get("filename", data.get("file_name", ""))),
            file_hash=data.get("fileHash", data.get("file_hash", "")),
            transaction_hash=(
                data.get("transactionHash", "") or blockchain.get("transaction_hash", "")
            ),
            transaction_url=(data.get("transactionUrl", "") or blockchain.get("explorer_url", "")),
            created_at=data.get("createdAt", data.get("created_at", data.get("timestamp", ""))),
            author_name=data.get("authorName", data.get("author_name", "")),
            file_type=data.get("fileType", data.get("file_type", "")),
            file_size=data.get("fileSize", data.get("file_size", 0)),
            blockchain_status=data.get("blockchainStatus", data.get("status", "")),
            is_public=data.get("isPublic", data.get("is_public", True)),
            certificate_url=data.get("certificateUrl", data.get("certificate_url", "")),
            verify_url=data.get("verifyUrl", data.get("verify_url", "")),
            reversibility_class=data.get(
                "reversibility_class", metadata.get("reversibility_class")
            ),
            timing_breakdown=timing,
        )


@dataclass
class BatchResultSummary:
    """Summary of a batch certification request."""

    total: int = 0
    created: int = 0
    existing: int = 0

    @property
    def certified(self) -> int:
        return self.created

    @property
    def failed(self) -> int:
        return self.total - self.created - self.existing


@dataclass
class BatchResult:
    """Result of a batch certification request."""

    batch_id: str = ""
    results: list[Certification] = field(default_factory=list)
    summary: BatchResultSummary = field(default_factory=BatchResultSummary)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BatchResult":
        """Create a BatchResult from an API response dictionary."""
        raw_results = data.get("results", [])
        results = [Certification.from_dict(r) for r in raw_results]

        summary = BatchResultSummary(
            total=data.get("total", len(raw_results)),
            created=data.get("created", 0),
            existing=data.get("existing", 0),
        )

        return cls(
            batch_id=data.get("batch_id", ""),
            results=results,
            summary=summary,
        )


@dataclass
class PricingTier:
    """A single pricing tier."""

    min_certifications: int = 0
    max_certifications: Optional[int] = None
    price_usd: float = 0.0


@dataclass
class PricingInfo:
    """Current pricing information from the Prove Before Act API."""

    protocol: str = ""
    version: str = ""
    price_usd: float = 0.0
    tiers: list[PricingTier] = field(default_factory=list)
    payment_methods: list[dict[str, str]] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PricingInfo":
        """Create a PricingInfo from an API response dictionary."""
        tiers: list[PricingTier] = []
        for t in data.get("tiers", []):
            tiers.append(
                PricingTier(
                    min_certifications=t.get("min_certifications", t.get("min", 0)),
                    max_certifications=t.get("max_certifications", t.get("max")),
                    price_usd=t.get("price_usd", t.get("price", 0.0)),
                )
            )

        return cls(
            protocol=data.get("protocol", ""),
            version=data.get("version", ""),
            price_usd=data.get("price_usd", data.get("current_price", 0.0)),
            tiers=tiers,
            payment_methods=data.get("payment_methods", []),
            raw=data,
        )


@dataclass
class TrialInfo:
    """Trial quota information returned by agent registration."""

    quota: int = 0
    used: int = 0
    remaining: int = 0


@dataclass
class RegistrationResult:
    """Result of agent self-service registration."""

    api_key: str
    agent_name: str
    trial: TrialInfo = field(default_factory=TrialInfo)
    endpoints: dict[str, str] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RegistrationResult":
        """Create a RegistrationResult from an API response dictionary."""
        trial_data = data.get("trial", {})
        trial = TrialInfo(
            quota=trial_data.get("quota", 0),
            used=trial_data.get("used", 0),
            remaining=trial_data.get("remaining", 0),
        )
        return cls(
            api_key=data.get("api_key", ""),
            agent_name=data.get("agent_name", ""),
            trial=trial,
            endpoints=data.get("endpoints", {}),
            raw=data,
        )
