"""Prove Before Act Python SDK — blockchain proof records on MultiversX.

The ``xproof`` package name is retained as a legacy compatibility identifier.
"""

from .client import XProofClient
from .exceptions import (
    AuthenticationError,
    ConflictError,
    NotFoundError,
    PolicyViolationError,
    RateLimitError,
    ServerError,
    ValidationError,
    XProofError,
)
from .models import (
    JURISDICTION_TYPES,
    BatchFileEntry,
    BatchResult,
    BatchResultSummary,
    Certification,
    CertifyEntry,
    CoherenceLinkResult,
    ConfidenceTrail,
    ConfidenceTrailStage,
    ContextDrift,
    ContextDriftStage,
    JurisdictionType,
    PathCertifyEntry,
    PolicyCheckResult,
    PolicyViolation,
    PricingInfo,
    PricingTier,
    RegistrationResult,
    ReversibilityClass,
    TimingBreakdown,
    TrialInfo,
)
from .utils import hash_bytes, hash_file

try:
    from importlib.metadata import version as _pkg_version

    __version__ = _pkg_version("xproof")
except Exception:
    __version__ = "0.2.11"  # fallback when running from uninstalled source

__all__ = [
    "XProofClient",
    "hash_file",
    "hash_bytes",
    "BatchFileEntry",
    "CertifyEntry",
    "PathCertifyEntry",
    "Certification",
    "CoherenceLinkResult",
    "BatchResult",
    "BatchResultSummary",
    "ConfidenceTrail",
    "ConfidenceTrailStage",
    "ContextDrift",
    "ContextDriftStage",
    "JURISDICTION_TYPES",
    "JurisdictionType",
    "TimingBreakdown",
    "PolicyCheckResult",
    "PolicyViolation",
    "ReversibilityClass",
    "PricingInfo",
    "PricingTier",
    "RegistrationResult",
    "TrialInfo",
    "XProofError",
    "AuthenticationError",
    "ConflictError",
    "NotFoundError",
    "PolicyViolationError",
    "RateLimitError",
    "ServerError",
    "ValidationError",
]
