import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "wouter";
import { ArrowUpRight, Check, Copy, FileKey2, RotateCw, ShieldAlert } from "lucide-react";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";
import { PbaMark } from "@/components/pba-mark";
import { startVisibilityAwarePolling } from "@/hooks/visible-polling";
import "./verify.css";

type Verdict = { status?: string; reason?: string };
type Attestation = {
  id: string;
  profile?: string;
  request_digest?: string;
  subject?: unknown;
  origin?: string;
  verdicts?: { why?: Verdict; what?: Verdict; link?: Verdict };
  verified?: boolean;
  issued_at?: string;
  key_id?: string;
  signature?: string;
  evidence?: unknown;
};
type VerificationResponse = {
  attestation: Attestation;
  canonical: unknown;
  public_key: unknown;
  current: {
    status?: string;
    events?: unknown[];
    witness_key_revocation?: {
      witness_id: string;
      witness_public_key: string;
      reason: string;
      revoked_at: string;
      canonical: string;
      signature: string;
      key_id: string;
      public_key: string;
    } | null;
  };
  verify_url?: string;
};
type LoadState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: VerificationResponse; refreshError?: string };

const verdictKeys = ["why", "what", "link"] as const;

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "Not supplied";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function dateText(value?: string): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" }) + " UTC";
}

function toneFor(value?: string): "verified" | "rejected" | "pending" {
  const status = (value ?? "").toLowerCase();
  if (["verified", "valid"].includes(status)) return "verified";
  if (["rejected", "invalid", "revoked", "replaced", "superseded"].includes(status)) return "rejected";
  return "pending";
}

function CopyValue({ value, label, multiline = false }: { value: unknown; label: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = pretty(value);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="verify-copy-block">
      <div className="verify-copy-block__value">
        {multiline ? <pre>{text}</pre> : <code>{text}</code>}
      </div>
      <button type="button" className="verify-copy" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

function StatusPill({ status, tone: explicitTone }: { status?: string; tone?: "verified" | "rejected" | "pending" }) {
  const tone = explicitTone ?? toneFor(status);
  const label = status || "inconclusive";
  return <span className={`verify-status verify-status--${tone}`}><i aria-hidden="true" />{label}</span>;
}

/** Retired records preserve their signed verdict text, never its positive visual mark. */
export function VerificationVerdicts({
  verdicts,
  retired,
}: {
  verdicts?: Attestation["verdicts"];
  retired: boolean;
}) {
  return (
    <div className="verify-verdicts">
      {verdictKeys.map((key) => {
        const verdict = verdicts?.[key];
        const tone = retired && verdict?.status === "verified"
          ? "pending" : toneFor(verdict?.status);
        return (
          <article key={key} className={`verify-verdict verify-verdict--${tone}`}>
            <div className="verify-verdict__top"><h3>{key.toUpperCase()}</h3><StatusPill status={verdict?.status} tone={tone} /></div>
            <p>{verdict?.reason || "No explanation was included in the public record."}</p>
          </article>
        );
      })}
    </div>
  );
}

export default function VerifyPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let disposed = false;
    let hasLoaded = false;
    let inFlight = false;
    let controller: AbortController | undefined;
    setState({ kind: "loading" });
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/pba/verification/${encodeURIComponent(id)}`, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (response.status === 404) {
          if (!disposed) setState({ kind: "not-found" });
          return;
        }
        if (!response.ok) throw new Error(`The verification service returned ${response.status}.`);
        const data = await response.json() as VerificationResponse;
        if (!data?.attestation || !data?.current) throw new Error("The verification response was incomplete.");
        if (disposed) return;
        hasLoaded = true;
        setState({ kind: "ready", data });
      } catch (error: unknown) {
        if (disposed || (error instanceof Error && error.name === "AbortError")) return;
        const message = error instanceof Error ? error.message : "Could not retrieve this verification record.";
        if (!hasLoaded) setState({ kind: "error", message });
        else setState((current) => current.kind === "ready"
          ? { ...current, refreshError: message }
          : current);
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    const stopPolling = startVisibilityAwarePolling(refresh);
    return () => {
      disposed = true;
      stopPolling();
      controller?.abort();
    };
  }, [id, retry]);

  const reload = useCallback(() => setRetry((value) => value + 1), []);
  const recordId = id || "unknown";
  const ready = state.kind === "ready" ? state.data : null;
  const refreshError = state.kind === "ready" ? state.refreshError : undefined;
  const attestation = ready?.attestation;
  const currentStatus = ready && !refreshError ? (ready.current.status ?? "").toLowerCase() : "";
  const isRetired = currentStatus === "revoked" || currentStatus === "superseded";
  const isActiveNegative = currentStatus === "not_verified";
  const isCurrentVerified = currentStatus === "verified" && attestation?.verified === true;
  const currentTone = isCurrentVerified ? "verified" : isRetired ? "rejected" : "pending";
  const currentDescription = isCurrentVerified
    ? "The server currently reports this record as verified. Independently verify its signature and payload before relying on it."
    : refreshError
      ? "Current status could not be refreshed. Treat this record as inconclusive until the public verification service is available."
    : ready?.current.witness_key_revocation
      ? `The recipient witness key was revoked: ${ready.current.witness_key_revocation.reason}. This historic record is no longer valid, even though its original signature remains intact.`
    : isRetired
      ? `This record is ${currentStatus}; it is no longer current. Its original signature remains inspectable, but must not be treated as current.`
      : isActiveNegative
        ? "The record is active but not verified. Review the signed verdicts; active status does not make an incomplete or rejected claim valid."
        : "Current status is unavailable or inconclusive. An issued attestation and its present validity are separate facts.";

  return (
    <div className="verify-page min-h-[100dvh]">
      <PublicSiteHeader />
      <main id="main-content" className="verify-main">
        <div className="verify-container">
          <div className="verify-breadcrumb"><span>PUBLIC STANDARD</span><span aria-hidden="true">/</span><span>RECORD VERIFICATION</span></div>
          {state.kind === "loading" && (
            <section className="verify-state-panel" aria-live="polite" aria-busy="true">
              <div className="verify-skeleton verify-skeleton--title" />
              <div className="verify-skeleton verify-skeleton--line" />
              <div className="verify-skeleton verify-skeleton--block" />
              <p>Retrieving the official record and current status…</p>
            </section>
          )}
          {(state.kind === "error" || state.kind === "not-found") && (
            <section className="verify-state-panel verify-state-panel--error" role="alert">
              <ShieldAlert size={27} aria-hidden="true" />
              <p className="verify-kicker">{state.kind === "not-found" ? "RECORD NOT FOUND" : "VERIFICATION UNAVAILABLE"}</p>
              <h1>{state.kind === "not-found" ? "No public record at this address." : "The record could not be checked."}</h1>
              <p>{state.kind === "not-found" ? "This identifier does not resolve to a published PBA attestation." : `${state.message} No conclusion about the proof can be drawn.`}</p>
              <div className="verify-error-actions">
                {state.kind === "error" && <button type="button" className="verify-primary-action" onClick={reload}><RotateCw size={15} /> Retry lookup</button>}
                <a className="verify-text-action" href="/">Return to PBA <ArrowUpRight size={14} /></a>
              </div>
            </section>
          )}

          {ready && attestation && (
            <>
              <header className="verify-heading">
                <div className="verify-heading__copy">
                  <p className="verify-kicker">PUBLIC ATTESTATION · {attestation.profile || "PBA"}</p>
                  <h1>Verification record</h1>
                  <p className="verify-lede">A signed statement with independently inspectable evidence. This is a proof record—not a trust score.</p>
                </div>
                <PbaMark id={recordId} size={124} className="verify-heading__mark" />
              </header>

              <section className={`verify-overview verify-overview--${currentTone}`} aria-labelledby="overview-title">
                <div className="verify-overview__top">
                  <div>
                    <p className="verify-kicker" id="overview-title">RECORD ID</p>
                    <p className="verify-record-id">{attestation.id}</p>
                  </div>
                  <div className="verify-current-status">
                    <span className="verify-kicker">CURRENT STATUS</span>
                    <StatusPill status={refreshError ? undefined : ready.current.status} tone={currentTone} />
                  </div>
                </div>
                <p className="verify-overview__note">
                  {currentDescription}
                </p>
                <p className="verify-overview__note">
                  {attestation.profile === "pba-http-delivery-v1"
                    ? "This profile checks an HTTPS POST accepted by a registered independent recipient witness. It does not prove a later file write, trade, publication, or other business effect."
                    : "This profile checks an observed MultiversX transaction. It does not prove an off-chain action or its outcome."}
                </p>
              </section>

              <section className="verify-section" aria-labelledby="fourw-title">
                <div className="verify-section__heading"><div><p className="verify-kicker">THE DECLARED CLAIM</p><h2 id="fourw-title">Three verification questions</h2></div><span className="verify-section-index">01 / 04</span></div>
                <VerificationVerdicts verdicts={attestation.verdicts} retired={isRetired} />
              </section>

              <section className="verify-section" aria-labelledby="identity-title">
                <div className="verify-section__heading"><div><p className="verify-kicker">COMMITMENT & ORIGIN</p><h2 id="identity-title">What was signed</h2></div><span className="verify-section-index">02 / 04</span></div>
                <div className="verify-facts">
                  <div className="verify-fact"><span>Subject</span><CopyValue value={attestation.subject} label="subject" /></div>
                  <div className="verify-fact"><span>Origin</span><CopyValue value={attestation.origin} label="origin" /></div>
                  <div className="verify-fact"><span>Request digest</span><CopyValue value={attestation.request_digest} label="request digest" /></div>
                  <div className="verify-fact"><span>Issued at</span><p>{dateText(attestation.issued_at)}</p></div>
                </div>
              </section>

              <section className="verify-section" aria-labelledby="signature-title">
                <div className="verify-section__heading"><div><p className="verify-kicker">CRYPTOGRAPHIC MATERIAL</p><h2 id="signature-title">Signature & signed payload</h2></div><span className="verify-section-index">03 / 04</span></div>
                <div className="verify-crypto-grid">
                  <article className="verify-data-panel">
                    <div className="verify-data-panel__heading"><FileKey2 size={16} aria-hidden="true" /><h3>Signature</h3></div>
                    <p className="verify-field-caption">Key ID · <code>{attestation.key_id || "Not supplied"}</code></p>
                    <CopyValue value={attestation.signature} label="signature" multiline />
                  </article>
                  <article className="verify-data-panel">
                    <div className="verify-data-panel__heading"><FileKey2 size={16} aria-hidden="true" /><h3>Canonical signed payload</h3></div>
                    <p className="verify-field-caption">Verify the signature against these exact bytes / fields as defined by the PBA standard.</p>
                    <CopyValue value={ready.canonical} label="canonical payload" multiline />
                  </article>
                  <article className="verify-data-panel verify-data-panel--key">
                    <div className="verify-data-panel__heading"><FileKey2 size={16} aria-hidden="true" /><h3>Public verification key</h3></div>
                    <CopyValue value={ready.public_key} label="public key" multiline />
                  </article>
                </div>
              </section>

              <section className="verify-section" aria-labelledby="evidence-title">
                <div className="verify-section__heading"><div><p className="verify-kicker">PUBLIC EVIDENCE</p><h2 id="evidence-title">Evidence & lifecycle</h2></div><span className="verify-section-index">04 / 04</span></div>
                <div className="verify-evidence-grid">
                  <article className="verify-data-panel">
                    <div className="verify-data-panel__heading"><h3>Evidence attached to the original record</h3></div>
                    <CopyValue value={attestation.evidence} label="evidence" multiline />
                  </article>
                  <article className="verify-data-panel">
                    <div className="verify-data-panel__heading"><h3>Current lifecycle events</h3></div>
                    {ready.current.events?.length ? <CopyValue value={ready.current.events} label="lifecycle events" multiline /> : <p className="verify-empty-evidence">No lifecycle events are currently published.</p>}
                  </article>
                  {ready.current.witness_key_revocation && (
                    <article className="verify-data-panel">
                      <div className="verify-data-panel__heading"><ShieldAlert size={16} aria-hidden="true" /><h3>Signed witness key revocation</h3></div>
                      <p className="verify-field-caption">The original proof is preserved, but the current mark is invalid.</p>
                      <CopyValue value={ready.current.witness_key_revocation} label="signed witness key revocation" multiline />
                    </article>
                  )}
                </div>
                <div className={`verify-lifecycle verify-lifecycle--${currentTone}`}>
                  <span className="verify-lifecycle__marker" aria-hidden="true" />
                  <p><strong>Present-day check:</strong> {ready.current.status || "No conclusive status"}{ready.current.events?.length ? ` · ${ready.current.events.length} event${ready.current.events.length === 1 ? "" : "s"} reported` : ""}.</p>
                  <span>Issued status does not override revocation or replacement.</span>
                </div>
              </section>

              <section className="verify-instructions" aria-labelledby="independent-title">
                <p className="verify-kicker">FOR HUMANS & AUTONOMOUS AGENTS</p>
                <h2 id="independent-title">Verify independently before acting.</h2>
                <ol>
                  <li><span>01</span><p>Fetch this record from its canonical verification URL; do not rely on a copied mark or screenshot.</p></li>
                  <li><span>02</span><p>Use the published key and the PBA canonicalization rules to verify the signature over the original payload.</p></li>
                  <li><span>03</span><p>Check the latest lifecycle state, including revocation and replacement events, at the moment of use.</p></li>
                </ol>
                <div className="verify-canonical-url"><span>CANONICAL LOOKUP</span><code>{ready.verify_url || `${window.location.origin}/verify/${encodeURIComponent(recordId)}`}</code></div>
              </section>
            </>
          )}
          <footer className="verify-page-footer"><span>PROVE BEFORE ACT</span><span>OPEN PROOF STANDARD · PUBLIC RECORD</span></footer>
        </div>
      </main>
      <PublicSiteFooter />
    </div>
  );
}