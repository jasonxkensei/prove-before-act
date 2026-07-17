import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Shield,
  ExternalLink,
  CheckCircle,
  XCircle,
  Clock,
  User,
  Hash,
  Brain,
  ArrowLeft,
  Layers,
  AlertTriangle,
  Copy,
  Check,
  Search,
  Activity,
  TrendingUp,
  FileText,
  Link2,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Zap,
  Share2,
  Code2,
  Timer,
  CalendarClock,
  ArrowDown,
  Info,
  Target,
} from "lucide-react";

function CopyInline({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="icon"
      variant="ghost"
      className="shrink-0"
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      data-testid="button-copy-inline"
      title={label ? `Copy ${label}` : "Copy"}
    >
      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      data-testid="button-share-report"
    >
      {copied ? <Check className="mr-2 h-3.5 w-3.5 text-primary" /> : <Share2 className="mr-2 h-3.5 w-3.5" />}
      {copied ? "Copied!" : label}
    </Button>
  );
}

const CHECK_EXPLANATIONS: Record<string, string> = {
  "intent_preceded_execution": "The WHY proof was certified on-chain BEFORE the WHAT proof. This is the core Prove Before Act guarantee — the agent's reasoning is immutably timestamped before the outcome.",
  "why_certified": "A WHY proof exists and has been committed to the MultiversX blockchain, anchoring the agent's full reasoning, context, and decision before execution.",
  "what_certified": "A WHAT proof exists and has been committed to the MultiversX blockchain, anchoring the actual result of the action after execution.",
  "session_anchored": "A session heartbeat proof was certified, recording the broader context of this agent session — total actions, duration, and karma.",
  "all_confirmed": "Every proof in this audit trail has been confirmed on-chain by MultiversX validators. Unconfirmed proofs could indicate a pending or failed blockchain transaction.",
};

function CheckRow({
  pass,
  label,
  tooltip,
}: {
  pass: boolean | null;
  label: string;
  tooltip?: string;
}) {
  if (pass === null) return null;
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      {pass ? (
        <CheckCircle className="h-4 w-4 text-green-500 dark:text-green-400 shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-red-500 dark:text-red-400 shrink-0" />
      )}
      <span
        className={`text-sm flex-1 ${pass ? "" : "text-red-600 dark:text-red-400 font-medium"}`}
        data-testid={`verification-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        {label}
      </span>
      {tooltip && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help shrink-0" />
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs text-xs">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function RoleBadge({ role, isContested }: { role: string; isContested?: boolean }) {
  const config: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
    WHY: { label: "WHY — Reasoning", variant: "default" },
    WHAT: { label: "WHAT — Result", variant: "secondary" },
    heartbeat: { label: "SESSION HEARTBEAT", variant: "outline" },
    contested: { label: "CONTESTED", variant: "outline" },
  };
  const c = config[role] || { label: role, variant: "outline" as const };
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Badge
        variant={c.variant}
        className="text-[10px] font-mono uppercase"
        data-testid={`badge-role-${role.toLowerCase()}`}
      >
        {c.label}
      </Badge>
      {isContested && (
        <Badge
          variant="outline"
          className="text-[10px] font-mono text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
          data-testid="badge-contested-proof"
        >
          <Target className="h-2.5 w-2.5 mr-1" />
          CONTESTED PROOF
        </Badge>
      )}
    </div>
  );
}

// Derives a visual severity from verdict + verification.
// "anomaly" is split into two visual levels:
//   - "violation" (red)  → proven order reversal (WHAT before WHY on-chain)
//   - "gap"      (amber) → WHY link not found, but no proof of fraud
function resolveVisualSeverity(
  verdict: any,
  verification: any,
): "clean" | "gap" | "violation" | "incomplete" {
  if (!verdict) return "incomplete";
  if (verdict.status === "clean") return "clean";
  if (verdict.status === "anomaly") {
    if (verification?.intent_preceded_execution === false) return "violation";
    return "gap";
  }
  return "incomplete";
}

function VerdictBanner({
  verdict,
  deltaSec,
  verification,
}: {
  verdict: any;
  deltaSec: number | null;
  verification: any;
}) {
  if (!verdict) return null;

  const severity = resolveVisualSeverity(verdict, verification);

  const config: Record<
    string,
    {
      icon: typeof ShieldCheck;
      bg: string;
      border: string;
      text: string;
      badge: string;
      label: string;
    }
  > = {
    clean: {
      icon: ShieldCheck,
      bg: "bg-green-500/5 dark:bg-green-500/10",
      border: "border-green-500/20",
      text: "text-green-700 dark:text-green-400",
      badge: "text-green-700 dark:text-green-300 border-green-500/30 bg-green-500/10",
      label: verdict.label,
    },
    gap: {
      icon: ShieldQuestion,
      bg: "bg-amber-500/5 dark:bg-amber-500/10",
      border: "border-amber-500/20",
      text: "text-amber-700 dark:text-amber-400",
      badge: "text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/10",
      label: "Reasoning Link Not Found",
    },
    violation: {
      icon: ShieldAlert,
      bg: "bg-red-500/5 dark:bg-red-500/10",
      border: "border-red-500/20",
      text: "text-red-700 dark:text-red-400",
      badge: "text-red-700 dark:text-red-300 border-red-500/30 bg-red-500/10",
      label: "Order Violation Detected",
    },
    incomplete: {
      icon: ShieldQuestion,
      bg: "bg-yellow-500/5 dark:bg-yellow-500/10",
      border: "border-yellow-500/20",
      text: "text-yellow-700 dark:text-yellow-400",
      badge: "text-yellow-700 dark:text-yellow-300 border-yellow-500/30 bg-yellow-500/10",
      label: verdict.label,
    },
  };

  const c = config[severity];
  const Icon = c.icon;

  return (
    <div
      className={`rounded-md border ${c.border} ${c.bg} p-5 mb-6`}
      data-testid="verdict-banner"
    >
      <div className="flex items-start gap-4">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-full ${c.bg} border ${c.border} shrink-0`}
        >
          <Icon className={`h-5 w-5 ${c.text}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap mb-1">
            <h2
              className={`text-lg font-semibold ${c.text}`}
              data-testid="text-verdict-label"
            >
              {c.label}
            </h2>
            <Badge
              variant="outline"
              className={`text-[10px] font-mono ${c.badge}`}
            >
              {verdict.checks_passed}/{verdict.checks_total} checks passed
            </Badge>
            {deltaSec !== null && deltaSec >= 0 && (
              <Badge
                variant="outline"
                className={`text-[10px] font-mono ${c.badge}`}
                data-testid="badge-delta"
              >
                <Timer className="h-2.5 w-2.5 mr-1" />
                WHY anchored {formatDuration(deltaSec)} before WHAT
              </Badge>
            )}
            {deltaSec !== null && deltaSec < 0 && (
              <Badge
                variant="outline"
                className="text-[10px] font-mono text-red-700 dark:text-red-300 border-red-500/30 bg-red-500/10"
                data-testid="badge-delta-reversed"
              >
                <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                WHAT certified before WHY — order reversed
              </Badge>
            )}
          </div>
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-verdict-detail"
          >
            {severity === "gap"
              ? "The action was certified on-chain, but the system could not automatically pair a WHY (reasoning) proof to this specific action. This is often a metadata linking limitation, not evidence of misconduct."
              : verdict.detail}
          </p>
        </div>
      </div>

      {/* Human-readable explanation for non-clean verdicts */}
      {severity === "gap" && (
        <div className="mt-4 pt-4 border-t border-amber-500/20">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1.5">
            What does this mean?
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            xproof requires agents to anchor their reasoning (WHY) before acting (WHAT).
            This check looks for a WHY proof linked to this specific action.
            When WHY was certified before the action's target existed — for instance,
            reasoning anchored before a post was published — the automatic pairing
            can fail even if both proofs are present and valid.
            Check the session heartbeat below, which lists all proofs from this session.
          </p>
        </div>
      )}
      {severity === "violation" && (
        <div className="mt-4 pt-4 border-t border-red-500/20">
          <p className="text-xs font-medium text-red-700 dark:text-red-400 mb-1.5">
            What does this mean?
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            The WHAT proof (action result) was committed to the MultiversX blockchain
            before the WHY proof (reasoning). This reverses the "Prove Before Act" guarantee
            and is recorded as an order violation in the agent's audit trail.
          </p>
        </div>
      )}
    </div>
  );
}

function PlainSummaryBlock({
  data,
  deltaSec,
  proofId,
}: {
  data: any;
  deltaSec: number | null;
  proofId: string;
}) {
  const agentName = data.agent?.name || "Unknown Agent";
  const walletShort = data.agent?.wallet
    ? `${data.agent.wallet.slice(0, 6)}...${data.agent.wallet.slice(-4)}`
    : "";
  const verdictStatus = data.verdict?.status;
  const whyEntry = (data.timeline || []).find((e: any) => e.role === "WHY");
  const whenStr = whyEntry
    ? formatTimestamp(whyEntry.certified_at)
    : data.report_generated_at
    ? formatTimestamp(data.report_generated_at)
    : null;

  const severity = resolveVisualSeverity(data?.verdict, data?.verification);

  const verdictPhrases: Record<string, { phrase: string; cls: string }> = {
    clean: {
      phrase: "Timeline integrity verified — intent preceded execution.",
      cls: "text-green-700 dark:text-green-400 font-semibold",
    },
    gap: {
      phrase: "Reasoning link not found — the WHY proof could not be automatically paired to this action.",
      cls: "text-amber-700 dark:text-amber-400 font-semibold",
    },
    violation: {
      phrase: "Order violation — execution was recorded before the reasoning was anchored.",
      cls: "text-red-700 dark:text-red-400 font-semibold",
    },
    incomplete: {
      phrase: "Partial audit trail — some proofs are missing or unconfirmed.",
      cls: "text-yellow-700 dark:text-yellow-400 font-semibold",
    },
  };

  const vp = verdictPhrases[severity] || verdictPhrases.incomplete;

  return (
    <div
      className="rounded-md border border-border bg-muted/30 p-4 mb-6 text-sm leading-relaxed"
      data-testid="plain-summary"
    >
      <p className="text-foreground">
        Agent{" "}
        <span className="font-semibold">{agentName}</span>
        {walletShort && (
          <span className="text-muted-foreground font-mono text-xs ml-1">
            ({walletShort})
          </span>
        )}{" "}
        {whenStr ? (
          <>
            certified its reasoning{" "}
            <span className="font-medium">(WHY)</span> on{" "}
            <span className="font-mono font-medium">{whenStr}</span>
          </>
        ) : (
          "submitted a certification"
        )}
        {deltaSec !== null && deltaSec >= 0 ? (
          <>
            {" "}
            —{" "}
            <span className="font-semibold text-primary">
              {formatDuration(deltaSec)} before acting
            </span>
            . The actual result <span className="font-medium">(WHAT)</span>{" "}
            was anchored after execution.
          </>
        ) : deltaSec !== null && deltaSec < 0 ? (
          <>
            . The WHAT proof was anchored{" "}
            <span className="font-semibold text-red-600 dark:text-red-400">
              before the WHY proof — order reversed.
            </span>
          </>
        ) : (
          "."
        )}{" "}
        <span className={vp.cls}>{vp.phrase}</span>
      </p>
    </div>
  );
}

function WhenCard({ timeline }: { timeline: any[] }) {
  const whyEntry = timeline.find((e: any) => e.role === "WHY");
  const whatEntry = timeline.find((e: any) => e.role === "WHAT");
  const anchor = whyEntry || whatEntry;
  if (!anchor) return null;

  const d = new Date(anchor.certified_at);
  const dateStr = d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
          WHEN
        </p>
        <p
          className="text-lg font-bold tabular-nums"
          data-testid="text-when-date"
        >
          {dateStr}
        </p>
        <p
          className="text-sm font-mono text-muted-foreground mt-0.5"
          data-testid="text-when-time"
        >
          {timeStr}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          On-chain timestamp · MultiversX
        </p>
      </CardContent>
    </Card>
  );
}

function DeltaCard({
  deltaSec,
  verification,
}: {
  deltaSec: number | null;
  verification: any;
}) {
  const intentOk = verification?.intent_preceded_execution;

  return (
    <Card
      className={
        intentOk === true
          ? "border-green-500/20"
          : intentOk === false
          ? "border-red-500/20"
          : ""
      }
    >
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
          WHY → WHAT
        </p>
        {deltaSec !== null ? (
          <>
            <div className="flex items-baseline gap-2 mb-1">
              <span
                className={`text-2xl font-bold tabular-nums ${
                  intentOk === true
                    ? "text-green-600 dark:text-green-400"
                    : intentOk === false
                    ? "text-red-600 dark:text-red-400"
                    : ""
                }`}
                data-testid="text-delta-seconds"
              >
                {deltaSec >= 0 ? `+${formatDuration(deltaSec)}` : `−${formatDuration(Math.abs(deltaSec))}`}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {deltaSec >= 0
                ? "WHY anchored before WHAT"
                : "WHAT anchored before WHY"}
            </p>
            <p
              className={`text-xs font-medium mt-2 ${
                intentOk === true
                  ? "text-green-600 dark:text-green-400"
                  : intentOk === false
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground"
              }`}
            >
              {intentOk === true ? "✓ Prove Before Act confirmed" : intentOk === false ? "✗ Order violation detected" : "—"}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Insufficient data</p>
        )}
      </CardContent>
    </Card>
  );
}

function TrustCard({ trust, agent }: { trust: any; agent: any }) {
  if (!trust) return null;

  const levelColors: Record<string, string> = {
    Verified: "text-green-600 dark:text-green-400",
    Trusted: "text-green-600 dark:text-green-400",
    Active: "text-blue-600 dark:text-blue-400",
    Newcomer: "text-muted-foreground",
  };

  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
          Trust Score
        </p>
        <div className="flex items-baseline gap-2 mb-2">
          <span
            className="text-2xl font-bold tabular-nums"
            data-testid="text-trust-score"
          >
            {trust.score}
          </span>
          <Badge
            variant="outline"
            className={`text-[10px] font-mono ${levelColors[trust.level] || ""}`}
            data-testid="text-trust-level"
          >
            {trust.level}
          </Badge>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span>Total certifications</span>
            <span className="font-mono tabular-nums">{trust.cert_total}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>Active streak</span>
            <span className="font-mono tabular-nums">{trust.streak_weeks}w</span>
          </div>
          {trust.violation_penalty < 0 && (
            <div className="flex items-center justify-between gap-2 text-amber-600 dark:text-amber-400">
              <span>Audit penalty</span>
              <span className="font-mono tabular-nums">{trust.violation_penalty}</span>
            </div>
          )}
          {(trust.violations.fault > 0 || trust.violations.breach > 0) && (
            <div className="flex items-center justify-between gap-2 text-amber-600 dark:text-amber-400">
              <span className="whitespace-nowrap">Flags</span>
              <span className="font-mono tabular-nums whitespace-nowrap">
                {trust.violations.fault}f / {trust.violations.breach}b
              </span>
            </div>
          )}
        </div>
        <a
          href={`/agent/${agent.wallet || ""}`}
          className="text-xs text-primary hover:underline mt-2 inline-block"
          data-testid="link-agent-profile"
        >
          View full profile →
        </a>
      </CardContent>
    </Card>
  );
}

function TimelineEntry({
  entry,
  isLast,
  isContested,
}: {
  entry: any;
  isLast: boolean;
  isContested: boolean;
}) {
  const meta = entry.metadata || {};
  const isWhy = entry.role === "WHY";
  const isWhat = entry.role === "WHAT";
  const decisionChain =
    meta.decision_chain &&
    Array.isArray(meta.decision_chain) &&
    meta.decision_chain.length > 0;
  const rulesApplied =
    meta.rules_applied &&
    Array.isArray(meta.rules_applied) &&
    meta.rules_applied.length > 0;

  return (
    <div
      className="relative flex gap-4"
      data-testid={`timeline-entry-${entry.proof_id}`}
    >
      <div className="flex flex-col items-center">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-full border-2 shrink-0 ${
            isContested
              ? "border-amber-500/50 bg-amber-500/10"
              : isWhy
              ? "border-primary bg-primary/10"
              : isWhat
              ? "border-secondary bg-secondary/10"
              : "border-muted-foreground/30 bg-muted/50"
          }`}
        >
          {isWhy ? (
            <Brain className={`h-3.5 w-3.5 ${isContested ? "text-amber-500" : "text-primary"}`} />
          ) : isWhat ? (
            <Zap className={`h-3.5 w-3.5 ${isContested ? "text-amber-500" : "text-muted-foreground"}`} />
          ) : (
            <Hash className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
        {!isLast && <div className="w-px flex-1 bg-border mt-2" />}
      </div>

      <Card className={`flex-1 mb-4 ${isContested ? "border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/5" : ""}`}>
        <CardContent className="p-4">
          <div className="flex items-start gap-2 flex-wrap mb-3">
            <RoleBadge role={entry.role} isContested={isContested} />
            <div className="flex items-center gap-1.5 flex-wrap ml-auto">
              <Badge variant="outline" className="text-[10px] font-mono">
                {entry.action_type}
              </Badge>
              {entry.blockchain_status === "confirmed" ? (
                <Badge
                  variant="outline"
                  className="text-[10px] text-green-600 dark:text-green-400 border-green-500/30"
                >
                  confirmed
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="text-[10px] text-amber-600 dark:text-amber-400 border-amber-500/30"
                >
                  {entry.blockchain_status || "pending"}
                </Badge>
              )}
            </div>
          </div>

          {isWhy && (
            <p className="text-xs text-muted-foreground mb-3 pb-2 border-b">
              Full reasoning anchored on-chain before the agent acted. This is the
              cryptographic commitment that preceded execution.
            </p>
          )}
          {isWhat && (
            <p className="text-xs text-muted-foreground mb-3 pb-2 border-b">
              Actual result anchored on-chain after execution. Proves exactly what
              the agent produced.
            </p>
          )}

          <div className="space-y-2 text-sm">
            {meta.target_author && (
              <div className="flex items-center gap-2">
                <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground text-xs">Target:</span>
                <span
                  className="font-medium text-xs"
                  data-testid="text-target-author"
                >
                  {meta.target_author}
                </span>
              </div>
            )}

            {meta.content_preview && (
              <div
                className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground italic border-l-2 border-primary/20"
                data-testid="text-content-preview"
              >
                "{meta.content_preview}"
              </div>
            )}

            {decisionChain && (
              <div className="mt-3">
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Decision Chain
                  </p>
                </div>
                <div className="space-y-1.5 ml-5">
                  {meta.decision_chain.map((step: string, i: number) => (
                    <p
                      key={i}
                      className="text-xs text-muted-foreground pl-3 border-l-2 border-primary/30"
                      data-testid={`text-decision-step-${i}`}
                    >
                      {step}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {rulesApplied && (
              <div className="mt-2">
                <div className="flex items-center gap-2 mb-1.5">
                  <Shield className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Rules Applied
                  </p>
                </div>
                <div className="flex flex-wrap gap-1 ml-5">
                  {meta.rules_applied.map((rule: string, i: number) => (
                    <Badge key={i} variant="outline" className="text-[10px]">
                      {rule}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t pt-3 mt-3 space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Certified:</span>
                <span
                  className="font-mono"
                  data-testid="text-certified-at"
                >
                  {formatTimestamp(entry.certified_at)}
                </span>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <Hash className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Hash:</span>
                <span
                  className="font-mono truncate"
                  data-testid="text-file-hash"
                >
                  {entry.file_hash}
                </span>
                <CopyInline text={entry.file_hash} label="hash" />
              </div>

              {entry.transaction_hash && (
                <div className="flex items-center gap-2 text-xs">
                  <Link2 className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">Tx:</span>
                  <a
                    href={entry.explorer_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-primary hover:underline truncate"
                    data-testid="link-explorer"
                  >
                    {entry.transaction_hash.slice(0, 16)}...
                  </a>
                  <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                </div>
              )}

              {meta.prompt_hash && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Prompt hash:</span>
                  <span className="font-mono truncate">{meta.prompt_hash}</span>
                  <CopyInline text={meta.prompt_hash} label="prompt hash" />
                </div>
              )}

              {meta.content_hash && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Content hash:</span>
                  <span className="font-mono truncate">{meta.content_hash}</span>
                  <CopyInline text={meta.content_hash} label="content hash" />
                </div>
              )}

              {meta.trigger_content_hash && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Trigger hash:</span>
                  <span className="font-mono truncate">
                    {meta.trigger_content_hash}
                  </span>
                  <CopyInline text={meta.trigger_content_hash} label="trigger hash" />
                </div>
              )}

              <div className="flex items-center gap-2 text-xs pt-1">
                <Search className="h-3 w-3 text-muted-foreground shrink-0" />
                <a
                  href={entry.verify_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                  data-testid="link-verify"
                >
                  Verify independently →
                </a>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DeltaConnector({ deltaSec }: { deltaSec: number }) {
  const ok = deltaSec >= 0;
  return (
    <div className="flex items-center gap-3 mb-4 ml-4 pl-4" data-testid="delta-connector">
      <div className="flex flex-col items-center">
        <div className="w-px h-4 bg-border" />
        <ArrowDown
          className={`h-4 w-4 ${ok ? "text-green-500 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}
        />
        <div className="w-px h-4 bg-border" />
      </div>
      <div
        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-mono ${
          ok
            ? "border-green-500/20 bg-green-500/5 text-green-700 dark:text-green-400"
            : "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-400"
        }`}
      >
        <Timer className="h-3 w-3 shrink-0" />
        {ok
          ? `${formatDuration(deltaSec)} elapsed — WHY anchored before WHAT ✓`
          : `WHAT anchored ${formatDuration(Math.abs(deltaSec))} before WHY — order violation ✗`}
      </div>
    </div>
  );
}

function SessionBlock({
  session,
  wallet,
  currentProofId,
}: {
  session: any;
  wallet: string;
  currentProofId: string;
}) {
  if (!session) return null;
  const isCurrentProof = session.proof_id === currentProofId;

  return (
    <div className="relative flex gap-4" data-testid="timeline-session">
      <div className="flex flex-col items-center">
        <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-muted-foreground/30 bg-muted/50 shrink-0">
          <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      </div>
      <Card className="flex-1 mb-4">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <RoleBadge role="heartbeat" />
            <Badge variant="outline" className="text-[10px] font-mono">
              {session.certified_actions_in_session != null
                ? `${session.certified_actions_in_session}/${session.total_actions_in_session} certified`
                : `${session.total_actions_in_session} actions`}
            </Badge>
            {session.karma != null && (
              <Badge variant="outline" className="text-[10px] font-mono">
                karma {session.karma}
              </Badge>
            )}
          </div>

          {session.session_summary && (
            <p
              className="text-sm text-muted-foreground mb-3"
              data-testid="text-session-summary"
            >
              {session.session_summary}
            </p>
          )}

          <div className="space-y-1.5 text-xs">
            {session.session_timestamp && (
              <div className="flex items-center gap-2">
                <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Session start:</span>
                <span className="font-mono">
                  {formatTimestamp(session.session_timestamp)}
                </span>
              </div>
            )}

            {session.session_duration_sec != null && (
              <div className="flex items-center gap-2">
                <Activity className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Duration:</span>
                <span className="font-mono">
                  {formatDuration(session.session_duration_sec)}
                </span>
              </div>
            )}

            {session.transaction_hash && (
              <div className="flex items-center gap-2">
                <Link2 className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Tx:</span>
                <a
                  href={`https://explorer.multiversx.com/transactions/${session.transaction_hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-primary hover:underline truncate"
                  data-testid="link-session-explorer"
                >
                  {session.transaction_hash.slice(0, 16)}...
                </a>
                <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
              </div>
            )}

            {!isCurrentProof && (
              <div className="flex items-center gap-2">
                <TrendingUp className="h-3 w-3 text-muted-foreground shrink-0" />
                <a
                  href={`/incident/${wallet}/${session.proof_id}`}
                  className="text-primary hover:underline font-medium"
                  data-testid="link-session-incident"
                >
                  View full session report →
                </a>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function computeDelta(timeline: any[]): number | null {
  const why = timeline?.find((e: any) => e.role === "WHY");
  const what = timeline?.find((e: any) => e.role === "WHAT");
  if (!why || !what) return null;
  const whyMs = new Date(why.certified_at).getTime();
  const whatMs = new Date(what.certified_at).getTime();
  if (isNaN(whyMs) || isNaN(whatMs)) return null;
  return Math.round((whatMs - whyMs) / 1000);
}

export default function IncidentReportPage() {
  const params = useParams<{ wallet: string; proofId: string }>();
  const wallet = params.wallet || "";
  const proofId = params.proofId || "";

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/agents", wallet, "incident-report", proofId],
    queryFn: async () => {
      const res = await fetch(
        `/api/agents/${wallet}/incident-report?proof_id=${proofId}`
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(err.error || "Failed to load incident report");
      }
      return res.json();
    },
    enabled: !!wallet && !!proofId,
  });

  const deltaSec = data ? computeDelta(data.timeline || []) : null;
  const reportUrl = typeof window !== "undefined" ? window.location.href : "";
  const jsonUrl = `/api/agents/${wallet}/incident-report?proof_id=${proofId}`;

  if (!wallet || !proofId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">
              Missing wallet address or proof ID in URL.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              asChild
              variant="ghost"
              size="icon"
              data-testid="button-back"
            >
              <a href="/">
                <ArrowLeft className="h-4 w-4" />
              </a>
            </Button>
            <a
              href="/"
              className="flex items-center gap-2"
              data-testid="link-logo"
            >
              <img
                src="/xproof-logo.png"
                alt="xproof"
                className="h-7 w-auto"
              />
            </a>
            <Badge variant="outline" className="text-xs">
              Incident Report
            </Badge>
          </div>
          {data && (
            <div className="flex items-center gap-2">
              <Button
                asChild
                variant="ghost"
                size="sm"
                data-testid="button-json-endpoint"
                title="Open raw JSON endpoint (for agents)"
              >
                <a href={jsonUrl} target="_blank" rel="noopener noreferrer">
                  <Code2 className="mr-1.5 h-3.5 w-3.5" />
                  JSON
                </a>
              </Button>
              <CopyButton text={reportUrl} label="Share report" />
            </div>
          )}
        </div>
      </header>

      <div className="container py-8 max-w-3xl mx-auto">
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">
              Reconstructing audit trail...
            </p>
          </div>
        )}

        {error && (
          <Card>
            <CardContent className="p-8 text-center">
              <AlertTriangle className="h-9 w-9 text-destructive mx-auto mb-4" />
              <p className="font-semibold text-lg mb-1">Report unavailable</p>
              <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
                {(error as Error).message}
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button
                  asChild
                  variant="default"
                  size="sm"
                  data-testid="button-register-agent"
                >
                  <a href="/leaderboard">
                    <Zap className="mr-2 h-4 w-4" />
                    Register a public agent
                  </a>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  data-testid="button-back-to-proof"
                >
                  <a href={`/proof/${proofId}`}>
                    <FileText className="mr-2 h-4 w-4" />
                    View proof page
                  </a>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-5 max-w-sm mx-auto">
                Incident reports are available for any public proof. If your
                proof was certified with a trial key, registering a named agent
                on the leaderboard unlocks full trust analysis.
              </p>
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <div className="mb-4">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h1
                    className="text-2xl font-bold mb-1"
                    data-testid="text-report-title"
                  >
                    4W Incident Report
                  </h1>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
                    <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                    <span>Generated {formatTimestamp(data.report_generated_at)}</span>
                    <span className="text-border">·</span>
                    <span>Proof</span>
                    <code className="text-primary text-xs font-mono bg-primary/5 px-1 rounded">
                      {proofId.slice(0, 12)}...
                    </code>
                    <CopyInline text={proofId} label="proof ID" />
                  </div>
                </div>
              </div>
            </div>

            {data.agent?.partial && (
              <div
                className="flex items-start gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/5 px-4 py-3 mb-5"
                data-testid="banner-partial-report"
              >
                <Zap className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
                    Partial report — no public agent profile
                  </p>
                  <p className="text-xs text-yellow-600/80 dark:text-yellow-400/80 mt-0.5">
                    4W data was read directly from the proof. Register a named
                    agent on the{" "}
                    <a
                      href="/leaderboard"
                      className="underline underline-offset-2 hover:text-yellow-700 dark:hover:text-yellow-300"
                    >
                      leaderboard
                    </a>{" "}
                    to unlock full trust scoring and cross-proof pairing.
                  </p>
                </div>
              </div>
            )}

            <PlainSummaryBlock data={data} deltaSec={deltaSec} proofId={proofId} />

            <VerdictBanner verdict={data.verdict} deltaSec={deltaSec} verification={data.verification} />

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                    WHO
                  </p>
                  <p
                    className="font-semibold text-sm truncate"
                    data-testid="text-agent-name"
                  >
                    {data.agent.name || "Unknown Agent"}
                  </p>
                  {data.agent.sigil_id && (
                    <p
                      className="text-xs text-muted-foreground font-mono mt-1 truncate"
                      data-testid="text-sigil-id"
                    >
                      {data.agent.sigil_id}
                    </p>
                  )}
                  <div className="flex items-center gap-1 mt-1">
                    <p
                      className="text-xs text-muted-foreground font-mono truncate"
                      data-testid="text-wallet"
                    >
                      {data.agent.wallet
                        ? `${data.agent.wallet.slice(0, 6)}...${data.agent.wallet.slice(-4)}`
                        : ""}
                    </p>
                    <CopyInline text={data.agent.wallet || ""} label="wallet" />
                  </div>
                  <a
                    href={`/agent/${data.agent.wallet || ""}`}
                    className="text-xs text-primary hover:underline mt-1 inline-block"
                    data-testid="link-who-profile"
                  >
                    Profile →
                  </a>
                </CardContent>
              </Card>

              <WhenCard timeline={data.timeline || []} />
              <DeltaCard deltaSec={deltaSec} verification={data.verification} />
              <TrustCard trust={data.trust} agent={data.agent} />
            </div>

            <Card className="mb-8">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    4W Verification Checks
                  </p>
                  <Badge variant="outline" className="text-[10px] font-mono">
                    {data.verdict?.checks_passed}/{data.verdict?.checks_total} passed
                  </Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
                  <CheckRow
                    pass={data.verification.intent_preceded_execution}
                    label="Intent preceded execution (WHY before WHAT)"
                    tooltip={CHECK_EXPLANATIONS.intent_preceded_execution}
                  />
                  <CheckRow
                    pass={data.verification.why_certified}
                    label="WHY proof certified on-chain"
                    tooltip={CHECK_EXPLANATIONS.why_certified}
                  />
                  <CheckRow
                    pass={data.verification.what_certified}
                    label="WHAT proof certified on-chain"
                    tooltip={CHECK_EXPLANATIONS.what_certified}
                  />
                  <CheckRow
                    pass={data.verification.session_anchored}
                    label="Session heartbeat anchored"
                    tooltip={CHECK_EXPLANATIONS.session_anchored}
                  />
                  <CheckRow
                    pass={data.verification.all_confirmed}
                    label="All proofs blockchain-confirmed"
                    tooltip={CHECK_EXPLANATIONS.all_confirmed}
                  />
                </div>

                {data.verdict?.status === "anomaly" && (() => {
                  const sv = resolveVisualSeverity(data.verdict, data.verification);
                  const isViolation = sv === "violation";
                  const borderCls = isViolation ? "border-red-500/20" : "border-amber-500/20";
                  const iconCls = isViolation ? "text-red-500 dark:text-red-400" : "text-amber-500 dark:text-amber-400";
                  const textCls = isViolation ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-500";
                  return (
                    <div className={`mt-4 pt-4 border-t ${borderCls}`}>
                      <div className={`flex items-start gap-2 text-xs ${textCls}`}>
                        <AlertTriangle className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${iconCls}`} />
                        <p>
                          {data.verification.intent_preceded_execution === false &&
                            <><span className="font-semibold">Order violation:</span>{" "}The WHAT proof was committed on-chain before the WHY proof. This reverses the Prove Before Act guarantee — the outcome was recorded before the stated reasoning.</>}
                          {data.verification.intent_preceded_execution !== false &&
                            data.verification.all_confirmed === false &&
                            <><span className="font-semibold">Unconfirmed proofs:</span>{" "}One or more proofs are still pending confirmation on MultiversX. This check will re-evaluate once all transactions are confirmed.</>}
                          {data.verification.intent_preceded_execution !== false &&
                            data.verification.all_confirmed !== false &&
                            !data.verification.why_certified &&
                            <><span className="font-semibold">Reasoning link not found:</span>{" "}The system could not automatically pair a WHY proof to this action. This typically happens when the WHY was certified before the action's target existed (e.g. before a post was published). Check the session heartbeat — it may reference both proofs.</>}
                          {data.verification.intent_preceded_execution !== false &&
                            data.verification.all_confirmed !== false &&
                            data.verification.why_certified &&
                            !data.verification.what_certified &&
                            <><span className="font-semibold">Result not anchored:</span>{" "}No WHAT proof was found for this action. The actual result was not certified after execution.</>}
                        </p>
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            <div className="mb-8">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 shrink-0">
                  <Clock className="h-4 w-4 text-primary" />
                </div>
                <h2 className="text-lg font-semibold">Action Timeline</h2>
                <Badge variant="outline" className="text-xs">
                  {data.timeline.length} proof
                  {data.timeline.length !== 1 ? "s" : ""}
                </Badge>
                <p className="text-xs text-muted-foreground ml-auto hidden sm:block">
                  Chronological · oldest first
                </p>
              </div>

              <div className="pl-1">
                {data.timeline.map((entry: any, i: number) => {
                  const isContested = entry.proof_id === proofId;
                  const nextEntry = data.timeline[i + 1];
                  const showDelta =
                    deltaSec !== null &&
                    entry.role === "WHY" &&
                    nextEntry?.role === "WHAT";

                  return (
                    <div key={entry.proof_id}>
                      <TimelineEntry
                        entry={entry}
                        isLast={
                          i === data.timeline.length - 1 && !data.session && !showDelta
                        }
                        isContested={isContested}
                      />
                      {showDelta && (
                        <DeltaConnector deltaSec={deltaSec} />
                      )}
                    </div>
                  );
                })}

                <SessionBlock
                  session={data.session}
                  wallet={wallet}
                  currentProofId={proofId}
                />
              </div>
            </div>

            <Card className="mb-8 border-dashed">
              <CardContent className="p-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                  Machine-Readable Access
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  This report is available as structured JSON for programmatic consumption by agents, auditors, and integrations.
                </p>
                <div className="flex items-center gap-2 bg-muted/50 rounded-md px-3 py-2">
                  <code
                    className="text-xs font-mono text-foreground flex-1 truncate"
                    data-testid="text-json-endpoint"
                  >
                    GET {jsonUrl}
                  </code>
                  <CopyInline text={`${typeof window !== "undefined" ? window.location.origin : ""}${jsonUrl}`} label="API endpoint" />
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Returns <code className="font-mono text-[10px]">verdict</code>,{" "}
                  <code className="font-mono text-[10px]">verification</code>,{" "}
                  <code className="font-mono text-[10px]">timeline</code>,{" "}
                  <code className="font-mono text-[10px]">trust</code> — no auth required for public proofs.
                </p>
              </CardContent>
            </Card>

            <footer className="border-t pt-6 text-center text-sm text-muted-foreground">
              <p>
                This report was generated from on-chain data anchored on{" "}
                <a
                  href="https://multiversx.com"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  MultiversX
                </a>
                . Every proof is independently verifiable.
              </p>
              <p className="mt-2 text-xs">
                <a
                  href="/docs/4w"
                  className="text-primary hover:underline"
                  data-testid="link-4w-docs"
                >
                  4W Framework
                </a>
                {" · "}
                <a
                  href="/leaderboard"
                  className="text-primary hover:underline"
                  data-testid="link-leaderboard"
                >
                  Trust Leaderboard
                </a>
                {" · "}
                <a
                  href={`/agents/${wallet}`}
                  className="text-primary hover:underline"
                  data-testid="link-agent-profile"
                >
                  Agent Profile
                </a>
                {" · "}
                <a
                  href="/"
                  className="text-primary hover:underline"
                  data-testid="link-home"
                >
                  xproof.app
                </a>
              </p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
