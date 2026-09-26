import { useEffect, useState } from "react";
import { Link } from "wouter";

type Verdict = { status?: unknown; reason?: unknown };
type MarkPayload = {
  attestation?: { verdicts?: { why?: Verdict; what?: Verdict; link?: Verdict }; verified?: boolean };
  current?: { status?: string };
};
type SegmentKey = "why" | "what" | "link";

const segments: { key: SegmentKey; label: string; start: number }[] = [
  { key: "why", label: "WHY", start: -91 },
  { key: "what", label: "WHAT", start: 29 },
  { key: "link", label: "LINK", start: 149 },
];

function isNoLongerCurrent(status: unknown): boolean {
  const value = String(status ?? "").toLowerCase();
  return value === "revoked" || value === "superseded";
}

function statusTone(status: unknown): "verified" | "rejected" | "pending" {
  const value = String(status ?? "").toLowerCase();
  if (["verified", "valid", "pass", "passed", "accepted"].includes(value)) return "verified";
  if (["rejected", "invalid", "fail", "failed", "denied"].includes(value)) return "rejected";
  return "pending";
}

type PbaMarkProps = {
  id: string;
  className?: string;
  size?: number;
};

/** Live PBA mark. Its visual state is always sourced from the public verification endpoint. */
export function PbaMark({ id, className = "", size = 112 }: PbaMarkProps) {
  const [payload, setPayload] = useState<MarkPayload | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [selected, setSelected] = useState<SegmentKey | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPayload(null);
    setUnavailable(false);
    fetch(`/api/pba/verification/${encodeURIComponent(id)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Verification state unavailable");
        return response.json() as Promise<MarkPayload>;
      })
      .then(setPayload)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setUnavailable(true);
      });
    return () => controller.abort();
  }, [id]);

  const verdicts = payload?.attestation?.verdicts;
  const currentStatus = payload?.current?.status?.toLowerCase();
  const retired = isNoLongerCurrent(currentStatus);
  const activeState = currentStatus === "verified" || currentStatus === "not_verified";
  const stateConsistent = currentStatus !== "verified" || payload?.attestation?.verified === true;
  const hasConclusiveCurrentState = activeState && stateConsistent;
  const selectedVerdict = selected ? verdicts?.[selected] : undefined;
  const selectedReason = selectedVerdict?.reason;
  return (
    <div className={`pba-mark ${className}`} style={{ width: size }}>
      <div className="pba-mark__visual" style={{ width: size, height: size }}>
        <Link
          href={`/verify/${encodeURIComponent(id)}`}
          className="pba-mark__destination"
          aria-label={`Open PBA verification record ${id}`}
          title="Open the official verification record"
        >
          <svg viewBox="0 0 80 80" role="img" aria-label="PBA three-part verification mark">
            <circle cx="40" cy="40" r="33" fill="#0D1117" />
            <circle cx="40" cy="40" r="25" fill="none" stroke="currentColor" strokeWidth="7" opacity=".22" />
            {segments.map(({ key, label, start }) => {
              const tone = unavailable || !payload || !hasConclusiveCurrentState ? "pending" : statusTone(verdicts?.[key]?.status);
              return (
                <circle
                  key={key}
                  cx="40"
                  cy="40"
                  r="25"
                  fill="none"
                  stroke={`var(--pba-${tone})`}
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray="39 118"
                  transform={`rotate(${start} 40 40)`}
                  aria-hidden="true"
                  data-segment={label}
                />
              );
            })}
            <circle cx="40" cy="40" r="9" fill="currentColor" />
          </svg>
        </Link>
        {segments.map(({ key, label, start }) => {
          const radians = (start * Math.PI) / 180;
          const x = 50 + Math.cos(radians) * 42;
          const y = 50 + Math.sin(radians) * 42;
          return (
            <button
              key={key}
              type="button"
              className={`pba-mark__segment ${selected === key ? "is-selected" : ""}`}
              style={{ left: `${x}%`, top: `${y}%` }}
              aria-label={`${label}: ${unavailable || !payload || !hasConclusiveCurrentState ? "inconclusive" : statusTone(verdicts?.[key]?.status)}${retired ? ". Record no longer current" : ""}. Show explanation`}
              aria-pressed={selected === key}
              onClick={() => setSelected((current) => (current === key ? null : key))}
            >
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <p className="pba-mark__caption" aria-live="polite">
        {selected ? (
          retired ? <>Record no longer current · link remains available.</> : <><strong>{selected.toUpperCase()}</strong> · {selectedReason ? String(selectedReason) : "No public explanation supplied."}</>
        ) : unavailable ? "Live status unavailable · inconclusive" : !payload ? "Checking live status…" : retired ? "Record no longer current · link remains available." : !hasConclusiveCurrentState ? "Current status unavailable · inconclusive" : "Live PBA verification"}
      </p>
      <Link href={`/verify/${encodeURIComponent(id)}`} className="pba-mark__record-link">
        Open verification record
      </Link>
    </div>
  );
}
