import { useEffect, useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { hashFile } from "@/lib/hashUtils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { 
  Shield, 
  Wallet, 
  CheckCircle,
  Upload,
  ArrowRight,
  ChevronRight,
  Blocks,
  CreditCard,
  ShoppingCart,
  Award,
  Bot,
  Cog,
  BarChart3,
  Copy,
  Loader2,
  Key,
  File,
  ExternalLink,
  Link2,
  Terminal,
  Zap,
  Play,
  Network,
} from "lucide-react";
import { WalletLoginModal } from "@/components/wallet-login-modal";
import { ProofLookupForm } from "@/components/proof-lookup-form";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";
import { trackAgentCta, useAgentCtaExposure } from "@/lib/conversionTracking";
import { trackEvent } from "@/lib/analytics";
import {
  clearStoredTrialKey,
  markTrialKeyHandled,
  readStoredTrialKey,
  storeTrialKey,
} from "@/lib/trial-key-storage";
import { getSafeRedirectTo } from "@/lib/safe-redirect";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const QUICKSTART_SNIPPETS = {
  python: `import hashlib, requests

# 1. Hash your content locally — nothing leaves your machine
file_hash = hashlib.sha256(open("decision.md", "rb").read()).hexdigest()

# 2. Anchor — one API call, proof_id returned in ~1 second
proof = requests.post(
    "https://provebeforeact.com/api/proof",
    headers={"Authorization": "Bearer YOUR_PM_KEY"},
    json={"file_hash": file_hash, "filename": "decision.md"}
).json()

print(proof["verify_url"])  # → https://provebeforeact.com/proof/prf_...`,

  typescript: `import crypto from "crypto";

// 1. Hash locally
const content = await fs.readFile("decision.md");
const fileHash = crypto.createHash("sha256").update(content).digest("hex");

// 2. Anchor — one fetch call
const proof = await fetch("https://provebeforeact.com/api/proof", {
  method: "POST",
  headers: { Authorization: "Bearer YOUR_PM_KEY",
             "Content-Type": "application/json" },
  body: JSON.stringify({ file_hash: fileHash, filename: "decision.md" }),
}).then(r => r.json());

console.log(proof.verify_url); // → https://provebeforeact.com/proof/prf_...`,

  curl: `# 1. Compute SHA-256 locally
FILE_HASH=$(sha256sum decision.md | awk '{print $1}')

# 2. Anchor — one curl call
curl -s -X POST https://provebeforeact.com/api/proof \\
  -H "Authorization: Bearer YOUR_PM_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{\\"file_hash\\": \\"$FILE_HASH\\", \\"filename\\": \\"decision.md\\"}" \\
  | jq .verify_url
# → "https://provebeforeact.com/proof/prf_..."`,
};

type ProofResult = {
  proof_id?: string | number;
  verify_url?: string;
  blockchain?: { transaction_hash?: string; explorer_url?: string };
  trial?: { remaining?: number };
};

function getProofVerificationUrl(result: ProofResult): string | null {
  if (typeof result.verify_url === "string" && result.verify_url.trim()) {
    return result.verify_url;
  }

  if (result.proof_id !== undefined && result.proof_id !== null) {
    return `/proof/${encodeURIComponent(String(result.proof_id))}`;
  }

  return null;
}

function QuickStartCode({ onGetKey }: { onGetKey: () => void }) {
  const [lang, setLang] = useState<"python" | "typescript" | "curl">("python");
  const [copied, setCopied] = useState(false);
  const code = QUICKSTART_SNIPPETS[lang];

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    trackEvent("quickstart_code_copied", { language: lang });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-md border border-border/60 overflow-hidden" data-testid="section-quickstart-code">
      {/* Header */}
      <div className="flex items-center gap-0 border-b border-border/60 bg-muted/30 px-1">
        {(["python", "typescript", "curl"] as const).map((l) => (
          <button
            key={l}
            onClick={() => {
              setLang(l);
              trackEvent("quickstart_language_selected", { language: l });
            }}
            className={`px-4 py-2 text-xs font-mono font-medium transition-colors ${
              lang === l
                ? "text-foreground border-b-2 border-primary -mb-px"
                : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`tab-quickstart-${l}`}
          >
            {l}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 pr-2">
          <button
            onClick={onGetKey}
            className="text-xs text-primary hover:text-primary/80 font-medium transition-colors"
            data-testid="button-quickstart-get-key"
          >
            Get free key →
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            data-testid="button-quickstart-copy"
          >
            {copied ? (
              <><CheckCircle className="h-3.5 w-3.5 text-primary" /> Copied</>
            ) : (
              <><Copy className="h-3.5 w-3.5" /> Copy</>
            )}
          </button>
        </div>
      </div>
      {/* Code */}
      <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre text-foreground/85 bg-muted/20">
        {code}
      </pre>
    </div>
  );
}

export default function Landing() {
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [loginRedirectTo, setLoginRedirectTo] = useState(() => {
    const requestedPath = new URLSearchParams(window.location.search).get("returnTo") || undefined;
    return getSafeRedirectTo(requestedPath);
  });
  const { data: pricing } = useQuery<{
    current_price_usd: number;
    total_certifications: number;
  }>({
    queryKey: ["/api/pricing"],
  });
  const price = pricing ? `$${pricing.current_price_usd}` : "current live rate";

  const [agentName, setAgentName] = useState("");
  const [trialKey, setTrialKey] = useState<string | null>(null);
  const [trialAgentName, setTrialAgentName] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const [trialKeyHandled, setTrialKeyHandled] = useState(false);
  const heroTrialCtaRef = useAgentCtaExposure<HTMLAnchorElement>("landing", "hero_free_trial");
  const heroScenariosRef = useAgentCtaExposure<HTMLDivElement>("landing", "hero_scenarios");
  const trialRegisterCtaRef = useAgentCtaExposure<HTMLButtonElement>("landing", "trial_register");
  const scrollToFreeTrial = () => {
    requestAnimationFrame(() => {
      document.getElementById("free-trial")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedPath = params.get("returnTo");
    if (requestedPath && getSafeRedirectTo(requestedPath) === "/dashboard" && requestedPath !== "/dashboard") {
      params.delete("returnTo");
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
      );
    }
    if (window.location.hash === "#free-trial") {
      scrollToFreeTrial();
    } else if (window.location.hash === "#verify-proof") {
      requestAnimationFrame(() => {
        document.getElementById("verify-proof")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else if (window.location.hash === "#how-it-works") {
      requestAnimationFrame(() => {
        document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    const storedTrial = readStoredTrialKey();
    if (storedTrial) {
      setTrialKey(storedTrial.apiKey);
      setTrialAgentName(storedTrial.agentName);
      setTrialKeyHandled(storedTrial.handled);
    }
  }, []);

  useEffect(() => {
    if (!trialKey || trialKeyHandled) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "Your trial API key has not been copied or downloaded yet.";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [trialKey, trialKeyHandled]);

  const registerMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/agent/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Registration failed. Please try a different name.");
      return data;
    },
    onSuccess: (data, name) => {
      setTrialKey(data.api_key);
      setTrialAgentName(name);
      setTrialKeyHandled(false);
      storeTrialKey(data.api_key, name);
      setTrialError(null);
      trackEvent("trial_registration_succeeded", { location: "landing" });
    },
    onError: (err: Error) => {
      setTrialError(err.message);
      trackEvent("trial_registration_failed", { location: "landing" });
    },
  });

  // Single entry point for trial registration so the button click and the
  // Enter key record the same conversion telemetry before submitting.
  const submitTrialRegistration = () => {
    const name = agentName.trim();
    if (name.length < 2 || registerMutation.isPending) return;
    trackAgentCta("cta_clicked", "landing", "trial_register");
    trackEvent("trial_registration_started", { location: "landing" });
    registerMutation.mutate(name);
  };

  const handleCopyKey = () => {
    if (!trialKey) return;
    navigator.clipboard.writeText(trialKey).then(() => {
      markTrialKeyHandled();
      setTrialKeyHandled(true);
      trackEvent("trial_api_key_copied", { location: "landing" });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setTrialError("Copy failed. Please use the download button or copy the key manually.");
    });
  };

  const handleDownloadKey = () => {
    if (!trialKey) return;
    const blob = new Blob([`${trialKey}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${trialAgentName || "prove-before-act"}-api-key.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    markTrialKeyHandled();
    setTrialKeyHandled(true);
    trackEvent("trial_api_key_downloaded", { location: "landing" });
  };

  const handleClearTrialKey = () => {
    clearStoredTrialKey();
    setTrialKey(null);
    setTrialAgentName("");
    setTrialKeyHandled(false);
    setProofFile(null);
    setProofHash("");
    setProofResult(null);
    setProofError(null);
  };

  const handleConnect = (redirectTo = "/dashboard") => {
    trackEvent("wallet_login_opened", { location: "landing" });
    setLoginRedirectTo(redirectTo);
    setIsLoginModalOpen(true);
  };

  // — Live proof widget state —
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofHash, setProofHash] = useState<string>("");
  const [isHashing, setIsHashing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [proofResult, setProofResult] = useState<ProofResult | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [caseVerified, setCaseVerified] = useState(false);

  const handleFileSelect = async (file: File) => {
    setProofFile(file);
    setProofResult(null);
    setProofError(null);
    setIsHashing(true);
    try {
      const h = await hashFile(file);
      setProofHash(h);
    } finally {
      setIsHashing(false);
    }
  };

  const submitProofMutation = useMutation({
    mutationFn: async ({ hash, filename }: { hash: string; filename: string }) => {
      const res = await fetch("/api/proof", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${trialKey}`,
        },
        body: JSON.stringify({ file_hash: hash, filename }),
      });
      const data = await res.json() as ProofResult & { message?: string; error?: string };
      if (!res.ok) throw new Error(data.message || data.error || "Proof submission failed. Please try again.");
      if (!getProofVerificationUrl(data)) {
        throw new Error("Proof was created without a verification link. Please try again.");
      }
      return data;
    },
    onSuccess: (data) => {
      setProofResult(data);
      setProofError(null);
      trackEvent("proof_submission_succeeded", {
        location: "landing",
        blockchain_anchored: Boolean(data.blockchain?.transaction_hash),
      });
    },
    onError: (err: Error) => {
      setProofError(err.message);
      trackEvent("proof_submission_failed", { location: "landing" });
    },
  });

  const proofVerificationUrl = proofResult ? getProofVerificationUrl(proofResult) : null;

  return (
    <div className="page-shell min-w-0 max-w-full overflow-x-hidden">
      <PublicSiteHeader
        howItWorksHref="#how-it-works"
        primaryActionHref="#free-trial"
        onConnect={() => handleConnect()}
      />
      {/* Hero — thesis and evidence case file */}
      <main id="main-content" className="min-w-0 max-w-full overflow-x-hidden">
      <section className="border-b border-border bg-background px-5 py-10 md:px-12 md:py-14 lg:px-[9vw]">
        <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[1.12fr_.88fr]">
          <div>
            <div className="mb-6 flex items-center gap-2 font-mono text-[10px] font-medium tracking-[.14em] text-[#ffbe78]" data-testid="badge-prove-before-act">
              <span className="h-2 w-2 rounded-full bg-[#ffbe78] shadow-[0_0_0_4px_rgba(255,190,120,.08)]" />
              CONSEQUENCES REQUIRE EVIDENCE
            </div>
            <h1 className="mb-5 max-w-3xl text-[clamp(2.75rem,4.4vw,4rem)] font-semibold leading-[.98] tracking-[-.05em]">
              Your agent can act.<br /><span className="font-serif font-normal italic text-primary">Can it prove why it acted?</span>
            </h1>
            <p className="mb-5 max-w-xl text-base leading-7 text-[#8b949e]" data-testid="text-hero-positioning">
              When an autonomous agent moves money, changes production, signs a contract, or delegates to another agent, the audit trail cannot begin after the incident. Commit the decision basis before execution and leave evidence a reviewer can verify. <span className="text-white">10 free proofs · no wallet needed.</span>
            </p>
            <div ref={heroScenariosRef} className="mb-5 grid max-w-xl grid-cols-1 border-y border-[#1a1f26] py-2 font-mono text-[10px] uppercase tracking-[.1em] text-[#8b949e] sm:grid-cols-2" data-testid="hero-risk-scenarios">
              {[
                ["01", "Payment approval", "scenario_payment"],
                ["02", "Production deploy", "scenario_devops"],
                ["03", "Legal commitment", "scenario_legal"],
                ["04", "Agent delegation", "scenario_multi_agent"],
              ].map(([number, label, cta]) => (
                <a
                  key={cta}
                  href="#free-trial"
                  className="group flex min-h-9 items-center rounded-sm px-2 transition-colors hover:bg-[#1a1f26] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00ff9d]"
                  onClick={() => {
                    trackAgentCta("cta_clicked", "landing", cta as "scenario_payment" | "scenario_devops" | "scenario_legal" | "scenario_multi_agent");
                    trackEvent("risk_scenario_selected", { scenario: cta.replace("scenario_", "") });
                    scrollToFreeTrial();
                  }}
                >
                  <b className="mr-2 text-[#ffbe78] transition-colors group-hover:text-[#00ff9d]">{number}</b> {label}
                </a>
              ))}
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="h-12 border-primary bg-primary px-7 text-sm font-bold text-primary-foreground hover:bg-primary/90"
              data-testid="button-free-trial-hero"
            >
              <a
                href="#free-trial"
                ref={heroTrialCtaRef}
                onClick={() => {
                  trackAgentCta("cta_clicked", "landing", "hero_free_trial");
                  trackEvent("free_trial_cta_clicked", { location: "hero" });
                  scrollToFreeTrial();
                }}
              >
                Integrate your agent <ArrowRight className="ml-2 h-4 w-4" />
              </a>
            </Button>
            <Button
               asChild
               size="lg"
               variant="outline"
               className="h-12 border-border bg-transparent px-7 text-sm text-foreground hover:border-primary hover:bg-transparent hover:text-primary"
               data-testid="button-verify-proof-hero"
            >
                <a href="#verify-proof" onClick={() => trackEvent("verify_proof_cta_clicked", { location: "hero" })}>
                  Verify a proof <ArrowRight className="ml-2 h-4 w-4" />
               </a>
            </Button>
            </div>
            <p className="mt-6 flex flex-wrap gap-3 font-mono text-[10px] text-[#79847b]">
              <span className="text-[#ffbe78]">BEFORE THE ACTION</span><span>·</span><span>public pattern, reference implementation below</span>
            </p>
            <p className="mt-4 text-sm text-[#79847b]">
              Prefer a walkthrough? <a href="/demo" className="inline-flex items-center gap-1 text-foreground underline underline-offset-2" data-testid="link-demo-secondary"><Play className="h-3.5 w-3.5" /> Explore the controlled demo</a>
            </p>
            <p className="mt-4 text-sm text-[#79847b]">
              New to Prove Before Act? <a href="/learn" className="text-foreground underline underline-offset-2" data-testid="link-hero-learn">60-second overview →</a>
            </p>
            <p className="mt-3 text-xs text-[#79847b]">
              <span data-testid="text-hero-reference-implementation">xProof is the reference implementation of the </span>
              <a href="/standard" className="text-foreground underline underline-offset-2" data-testid="link-hero-standard">Prove Before Act specification</a>
            </p>
          </div>
          <div className="relative">
            <div className="rotate-[1deg] bg-[#e3e6dd] p-5 text-[#142019] shadow-[16px_18px_0_#1a251e] md:p-7" data-testid="card-evidence-case-file">
              <div className="flex items-center justify-between font-mono text-[10px] tracking-[.07em]">
                <span>DECISION RECORD / PRF_7A91</span><span className="flex items-center gap-1 text-[#197449]"><CheckCircle className="h-3.5 w-3.5" /> VERIFIED</span>
              </div>
              <div className="my-8 text-2xl font-semibold tracking-[-.04em]">Rebalance treasury exposure</div>
              <div className="space-y-0 text-[11px]">
                <div className="flex flex-col gap-1 border-t border-[#bac3b8] py-3 sm:flex-row sm:justify-between"><span className="font-mono text-[10px] text-[#65716a]">DECLARED DECISION BASIS</span><strong>RSI 38 · risk approved</strong></div>
                <div className="flex flex-col gap-1 border-t border-[#bac3b8] py-3 sm:flex-row sm:justify-between"><span className="font-mono text-[10px] text-[#65716a]">COMMITMENT TIMESTAMP</span><strong className="font-mono font-normal">2025-06-18 14:32:07 UTC</strong></div>
                <div className="flex flex-col gap-1 border-t border-[#bac3b8] py-3 sm:flex-row sm:justify-between"><span className="font-mono text-[10px] text-[#65716a]">ACTOR / RECORD</span><strong>treasury-agent · public proof</strong></div>
              </div>
              <div className="my-2 border-t border-dashed border-[#8b978d]" />
              <div className="flex items-center justify-between text-[11px]"><span className="flex items-center gap-2 font-mono text-[10px] text-[#65716a]"><span className="h-4 w-1 bg-[#38bd7a]" /> OUTCOME RECORDED</span><strong>Action completed · +0.8% USDC</strong></div>
              <button className="mt-5 flex items-center gap-2 border-0 bg-transparent p-0 text-[11px] text-[#17764b]" onClick={() => setCaseVerified(!caseVerified)} data-testid="button-case-file-verify">
                {caseVerified ? "Hide verification fields" : "Inspect verification fields"} <ExternalLink className="h-3 w-3" />
              </button>
              {caseVerified && <div className="mt-3 flex items-center gap-2 bg-[#d2ebda] p-2 text-[11px] text-[#18633f]"><CheckCircle className="h-4 w-4" /> Verification checks the record against its public commitment</div>}
            </div>
            <p className="mt-8 font-mono text-[10px] text-muted-foreground"><span className="mr-3 text-primary">01</span>The evidence is the product.</p>
          </div>
        </div>
      </section>

      <section id="why" className="border-b border-border px-5 py-20 md:px-[10vw] md:py-28">
        <div className="eyebrow mb-10">01 / THE THESIS</div>
        <div className="grid gap-10 md:grid-cols-2 md:gap-[12vw]">
          <h2 className="text-4xl font-semibold leading-none tracking-[-.05em] md:text-6xl">Autonomy without<br /><span className="font-serif font-normal italic text-primary">accountability</span> is a blind spot.</h2>
          <div className="max-w-md text-[15px] leading-7 text-muted-foreground"><p>Agents are moving money, changing infrastructure, and speaking for companies. A log of what happened is not enough.</p><p className="mt-5 text-muted-foreground/70">Prove Before Act adds a narrow, durable invariant: the agent must publish a commitment to its declared decision basis before the action can happen.</p><a href="/standard" className="mt-5 inline-flex items-center gap-2 text-xs text-primary" data-testid="link-thesis-standard">Read the PBA standard <ArrowRight className="h-4 w-4" /></a></div>
        </div>
        <div className="mt-16 flex flex-wrap items-center justify-between gap-4 border-y border-border py-6 font-mono text-[10px] tracking-[.1em] text-muted-foreground"><span>OBSERVE</span><b>→</b><span>DECIDE</span><b>→</b><strong className="text-primary">PROVE</strong><b>→</b><span>ACT</span><b>→</b><strong className="text-primary">PROVE</strong></div>
      </section>
      <section id="why-now" className="border-b border-border bg-card px-5 py-20 md:px-[10vw] md:py-28" data-testid="section-why-now">
        <div className="mx-auto max-w-6xl">
          <div className="eyebrow">02 / WHY NOW</div>
          <div className="mt-10 grid gap-12 lg:grid-cols-[.82fr_1.18fr] lg:gap-20">
            <div>
              <h2 className="max-w-xl text-4xl font-semibold leading-[.98] tracking-[-.05em] md:text-6xl">
                Evidence cannot be created
                <br />
                <span className="font-serif font-normal italic text-primary">after the fact.</span>
              </h2>
              <p className="mt-7 max-w-md text-[15px] leading-7 text-[#9da89e]">
                The right time to build an accountability record is before a client, auditor, insurer, or regulator asks for one.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row lg:flex-col lg:items-start xl:flex-row">
                <Button
                  asChild
                  className="border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                  data-testid="button-why-now-first-proof"
                >
                  <a
                    href="#free-trial"
                    onClick={() => {
                      trackAgentCta("cta_clicked", "landing", "why_now_first_proof");
                      trackEvent("free_trial_cta_clicked", { location: "why_now" });
                      scrollToFreeTrial();
                    }}
                  >
                    Prove your first agent decision <ArrowRight className="ml-2 h-4 w-4" />
                  </a>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="border-border bg-transparent text-foreground hover:border-primary hover:bg-transparent hover:text-primary"
                  data-testid="button-why-now-standard"
                >
                  <a href="/standard">Inspect the standard</a>
                </Button>
              </div>
            </div>

            <ol className="border-t border-border">
              {[
                {
                  number: "01",
                  title: "The downside is asymmetric.",
                  body: `A first integration is small and predictable: 10 free proofs, then the live rate is ${price}/proof. Waiting costs nothing—until someone asks for evidence that was never created. At that point, it cannot be reconstructed.`,
                },
                {
                  number: "02",
                  title: "The proof must precede the incident.",
                  body: "A record written after a dispute shows what you say happened. A commitment anchored before execution proves what the agent declared before it acted. The timestamp is the value.",
                },
                {
                  number: "03",
                  title: "A verifiable history compounds.",
                  body: "Operators that start now build a durable record across decisions and outcomes. When accountability becomes a requirement, they can show history—not a compliance process that began yesterday.",
                },
              ].map((argument) => (
                <li
                  key={argument.number}
                  className="grid gap-4 border-b border-border py-7 sm:grid-cols-[42px_1fr] sm:gap-6"
                  data-testid={`why-now-argument-${argument.number}`}
                >
                  <span className="font-mono text-[10px] tracking-[.12em] text-[#5f6d63]">{argument.number}</span>
                  <div>
                    <h3 className="text-lg font-semibold tracking-[-.02em] text-foreground">{argument.title}</h3>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-[#88948b]">{argument.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>
      <section id="loop" className="evidence-surface border-b px-5 py-20 md:px-[10vw] md:py-28">
        <div className="font-mono text-[10px] tracking-[.14em] text-[#287650]">03 / THE CANONICAL LOOP</div>
        <div className="mt-10 flex flex-col justify-between gap-5 md:flex-row md:items-end"><h2 className="text-4xl font-semibold leading-none tracking-[-.05em] md:text-6xl">A commitment is not<br /><span className="font-serif font-normal italic">a transcript.</span></h2><p className="max-w-md text-[15px] leading-7 text-[#56635a]">Declare the basis that can be inspected. Keep private cognition private. Make the boundary between intent and action public.</p></div>
        <div className="mt-12 grid border border-[#aeb8ae] md:grid-cols-5">
          {["Collect the relevant state.", "Declare the decision basis.", "Anchor the commitment.", "Execute the approved action.", "Record the outcome."].map((lead, i) => (
            <div
              key={lead}
              className={`min-h-[170px] border-b border-border p-5 last:border-0 md:border-b-0 md:border-r md:last:border-r-0 ${i === 2 ? "loop-step--highlighted" : ""}`}
            >
              <span className="loop-step-number font-mono text-[11px]">0{i + 1}</span>
              <h3 className="my-6 font-mono text-sm tracking-[.05em]">{["OBSERVE", "DECIDE", "PROVE", "ACT", "PROVE"][i]}</h3>
              <strong className="text-[13px]">{lead}</strong>
              <p className="loop-step-description mt-2 text-xs leading-5">{["Signals, files, balances, permissions.", "A concise, inspectable justification.", "Hash, timestamp, actor, issuer.", "The commitment travels with the action.", "Close the loop with what happened."][i]}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="border-b border-border bg-card px-5 py-16 md:px-[10vw] md:py-20">
        <div className="font-mono text-[10px] tracking-[.14em] text-[#758178]">THE PATTERN / THE IMPLEMENTATION</div>
        <div className="mt-8 grid gap-8 md:grid-cols-[1fr_70px_1fr] md:items-center"><div><h2 className="text-2xl font-semibold">Prove Before Act</h2><p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">An open pattern for public accountability. The invariant is simple enough to adopt across models, frameworks, and agents.</p></div><div className="text-3xl text-muted-foreground/70">→</div><div><h2 className="text-2xl font-semibold text-primary">xProof</h2><p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">The reference implementation. One API call anchors an independently verifiable proof on MultiversX.</p><a href="/docs" className="mt-4 inline-flex items-center gap-2 text-xs text-primary">Explore xProof <ArrowRight className="h-4 w-4" /></a></div></div>
      </section>

      <section id="choose-path" className="border-b border-border px-5 py-16 md:px-[10vw] md:py-20" data-testid="section-choose-path">
        <div className="mx-auto max-w-6xl">
          <div className="eyebrow">YOUR NEXT STEP</div>
          <h2 className="mt-5 text-3xl font-semibold tracking-[-.04em] md:text-5xl">One principle. Two ways in.</h2>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
            Commit before the action. Integrate that rule into your agent, or inspect an existing public proof.
          </p>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <div className="border border-primary/30 bg-primary/5 p-6 md:p-8">
              <p className="font-mono text-[10px] uppercase tracking-[.13em] text-primary">01 / I run an agent</p>
              <h3 className="mt-4 text-2xl font-semibold">Integrate</h3>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                Get a free API key, create your first proof, then connect the flow to your agent.
              </p>
              <a
                href="#free-trial"
                className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => trackEvent("free_trial_cta_clicked", { location: "choice" })}
                data-testid="link-choice-integrate"
              >
                Get your free key <ArrowRight className="h-4 w-4" />
              </a>
            </div>
            <div id="verify-proof" className="scroll-mt-24 border border-border bg-card p-6 md:p-8" data-testid="card-choice-verify">
              <p className="font-mono text-[10px] uppercase tracking-[.13em] text-primary">02 / I need to check a record</p>
              <h3 className="mt-4 text-2xl font-semibold">Verify</h3>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                Paste a public proof link or ID to inspect its current verification status. No account needed.
              </p>
              <ProofLookupForm />
            </div>
          </div>
        </div>
      </section>

      {/* Free Trial — Interactive Registration */}
      <section id="free-trial" className="border-y border-border bg-card py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-2xl text-center">
            <Badge variant="secondary" className="mb-4 px-3 py-1">
              <Key className="mr-2 h-3.5 w-3.5" />
              Free Trial — No wallet needed
            </Badge>
            <h2 className="mb-3 text-2xl md:text-3xl font-bold">
              10 free proofs. Start in 30 seconds.
            </h2>
            <p className="mb-8 text-muted-foreground max-w-xl mx-auto">
              Register your agent or project — get a <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">pm_</code> API key instantly. No wallet, no credit card.
            </p>

            {!trialKey ? (
              <div className="max-w-md mx-auto">
                <div className="flex flex-col sm:flex-row gap-3">
                  <Input
                    placeholder="Agent name (e.g. my-agent)"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        submitTrialRegistration();
                      }
                    }}
                    data-testid="input-trial-agent-name"
                    className="flex-1"
                  />
                  <Button
                    ref={trialRegisterCtaRef}
                    onClick={submitTrialRegistration}
                    disabled={agentName.trim().length < 2 || registerMutation.isPending}
                    data-testid="button-register-trial"
                  >
                    {registerMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Registering...
                      </>
                    ) : (
                      <>
                        Get my key
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
                {trialError && (
                  <p className="mt-3 text-sm text-destructive text-left" data-testid="text-trial-error">
                    {trialError}
                  </p>
                )}
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                  {["10 free proofs", "No wallet needed", "No credit card", "Claim to wallet anytime"].map((label) => (
                    <Badge key={label} variant="outline" className="text-xs">
                      {label}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : (
              <div className="max-w-lg mx-auto">
                {/* Key display */}
                <div className="mb-2 flex items-center gap-2 rounded-md bg-primary/10 border border-primary/20 p-3 font-mono text-sm">
                  <span className="flex-1 text-left truncate text-primary font-medium" data-testid="text-trial-key">{trialKey}</span>
                  <Button size="icon" variant="ghost" onClick={handleCopyKey} data-testid="button-copy-trial-key">
                    {copied ? <CheckCircle className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                {!trialKeyHandled && (
                  <p className="mb-3 text-left text-xs text-amber-300" role="status">
                    Save this key now. It is shown only once and will not be recoverable after this browser tab is closed.
                  </p>
                )}
                <div className="mb-5 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={handleDownloadKey} data-testid="button-download-trial-key">
                    Download key
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleClearTrialKey} data-testid="button-clear-trial-key">
                    I saved it — hide key
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground mb-5">
                  Your key is ready — 10 free proofs for <strong>{trialAgentName}</strong>. Try one right now:
                </p>

                {/* Live proof widget */}
                {!proofResult ? (
                  <>
                    {/* Drop zone */}
                    <div
                      data-testid="dropzone-proof"
                      className={`border-2 border-dashed rounded-md p-7 text-center cursor-pointer transition-colors select-none ${isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-primary/40"}`}
                      role="button"
                      tabIndex={0}
                      aria-label={proofFile ? `Choose a different file. Current file: ${proofFile.name}` : "Choose a file to prove"}
                      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setIsDragging(false);
                        const f = e.dataTransfer.files[0];
                        if (f) handleFileSelect(f);
                      }}
                      onClick={() => fileInputRef.current?.click()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          fileInputRef.current?.click();
                        }
                      }}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        data-testid="input-proof-file"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleFileSelect(f);
                        }}
                      />
                      {!proofFile ? (
                        <>
                          <Upload className="h-7 w-7 text-muted-foreground/50 mx-auto mb-3" />
                          <p className="text-sm font-medium text-muted-foreground">Select an output, decision log, data snapshot, or build artifact</p>
                          <p className="text-xs text-muted-foreground/60 mt-1">Only the SHA-256 hash is transmitted — source data stays in this runtime</p>
                        </>
                      ) : (
                        <div className="flex items-center gap-3 justify-center">
                          <File className="h-6 w-6 text-primary shrink-0" />
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium truncate max-w-xs">{proofFile.name}</p>
                            {isHashing ? (
                              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Computing SHA-256 hash…
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground font-mono mt-0.5">{proofHash.slice(0, 20)}…</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Anchor button */}
                    {proofFile && !isHashing && (
                      <Button
                        className="w-full mt-3"
                        onClick={() => {
                          trackEvent("proof_submission_started", { location: "landing" });
                          submitProofMutation.mutate({ hash: proofHash, filename: proofFile.name });
                        }}
                        disabled={submitProofMutation.isPending}
                        data-testid="button-anchor-proof"
                      >
                        {submitProofMutation.isPending ? (
                          <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Anchoring to blockchain…</>
                        ) : (
                          <><Shield className="mr-2 h-4 w-4" />Anchor this proof</>
                        )}
                      </Button>
                    )}

                    {proofError && (
                      <p className="mt-2 text-sm text-destructive text-left" data-testid="text-proof-error">{proofError}</p>
                    )}
                  </>
                ) : (
                  /* Success state */
                  (<>
                    <div className="rounded-md bg-primary/10 border border-primary/20 p-5 text-left" data-testid="card-proof-result">
                      <div className="flex items-center gap-2 mb-3">
                        <CheckCircle className="h-5 w-5 text-primary shrink-0" />
                        <p className="text-sm font-semibold text-primary">Proof anchored on MultiversX!</p>
                      </div>
                      <div className="space-y-1 mb-4">
                        <p className="text-xs text-muted-foreground">
                          File: <span className="font-medium text-foreground">{proofFile?.name}</span>
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          SHA-256: {proofHash.slice(0, 24)}…
                        </p>
                        {proofResult.proof_id && (
                          <p className="text-xs text-muted-foreground">
                            Proof ID: <span className="font-mono">{proofResult.proof_id}</span>
                          </p>
                        )}
                        {proofResult.blockchain?.transaction_hash && (
                          <p className="text-xs text-muted-foreground font-mono">
                            Tx: {proofResult.blockchain.transaction_hash.slice(0, 20)}…
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {proofVerificationUrl && (
                          <Button
                            asChild
                            size="sm"
                            variant="outline"
                            data-testid="button-view-proof"
                          >
                            <a
                              href={proofVerificationUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink className="mr-1.5 h-3 w-3" />
                              View proof
                            </a>
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (!proofVerificationUrl) return;
                            navigator.clipboard.writeText(
                              new URL(proofVerificationUrl, window.location.origin).toString(),
                            );
                          }}
                          data-testid="button-copy-proof-url"
                        >
                          <Link2 className="mr-1.5 h-3 w-3" />
                          Copy link
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setProofFile(null); setProofHash(""); setProofResult(null); setProofError(null); }}
                          data-testid="button-proof-another"
                        >
                          Anchor another
                        </Button>
                        {proofResult.trial?.remaining !== undefined && (
                          <Badge variant="outline" className="text-xs ml-auto">
                            {proofResult.trial.remaining} proof{proofResult.trial.remaining !== 1 ? "s" : ""} remaining
                          </Badge>
                        )}
                      </div>
                    </div>
                    {/* Post-success next steps — no wallet needed */}
                    <div className="mt-5 rounded-md border border-muted bg-muted/30 p-4 text-left">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Next: integrate into your fleet</p>
                      <div className="flex flex-col gap-2">
                        <div className="flex items-start gap-3">
                          <Terminal className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                          <div>
                            <p className="text-sm font-medium">Add one line to your agent's loop</p>
                            <p className="text-xs text-muted-foreground">
                              Hash the output → POST to <code className="font-mono bg-muted px-1 rounded">/api/proof</code> with your <code className="font-mono bg-muted px-1 rounded">pm_</code> key. 
                              Every action becomes a verifiable record.
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button asChild size="sm" data-testid="button-trial-fleet-docs">
                          <a href="/docs">
                            Fleet integration guide
                            <ArrowRight className="ml-1 h-3 w-3" />
                          </a>
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => handleConnect()} data-testid="button-trial-connect-wallet">
                          <Wallet className="mr-1.5 h-3.5 w-3.5" />
                          Connect wallet
                        </Button>
                      </div>
                    </div>
                  </>)
                )}

                {/* Pre-proof next steps (key obtained but no proof yet) */}
                {!proofResult && (
                <div className="mt-5 flex flex-wrap gap-3 justify-center">
                  <Button asChild variant="outline" size="sm" data-testid="button-trial-docs">
                    <a href="/docs">
                      Fleet integration guide
                      <ArrowRight className="ml-1 h-3 w-3" />
                    </a>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleConnect()} data-testid="button-trial-connect-wallet">
                    <Wallet className="mr-2 h-3.5 w-3.5" />
                    Connect wallet
                  </Button>
                </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
      {/* Quick Start — code first */}
      <section className="py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-3xl">
            <div className="mb-8 text-center">
              <Badge variant="outline" className="mb-4">Quick Start</Badge>
              <h2 className="mb-2 text-2xl md:text-3xl font-bold">Integrate in 2 minutes</h2>
              <p className="text-muted-foreground text-sm">Copy-paste ready. Python · TypeScript · curl.</p>
            </div>

            {/* Tab selector + code block */}
            <QuickStartCode onGetKey={() => {
              trackEvent("quickstart_get_key_clicked", { location: "landing" });
              scrollToFreeTrial();
            }} />

            {/* Three integration paths */}
            <div className="mt-6 grid gap-3 md:grid-cols-3">
              <div className="rounded-md border bg-muted/20 p-4" data-testid="card-quickstart-api">
                <div className="flex items-center gap-2 mb-2">
                  <Cog className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-sm font-semibold">REST API</span>
                </div>
                <p className="text-xs text-muted-foreground mb-3">POST a SHA-256 hash with your <code className="bg-muted px-1 rounded">pm_</code> key.</p>
                <Button asChild variant="outline" size="sm" data-testid="button-quickstart-docs">
                  <a href="/docs">Full docs <ArrowRight className="ml-1 h-3 w-3" /></a>
                </Button>
              </div>
              <div className="rounded-md border bg-muted/20 p-4" data-testid="card-quickstart-agent">
                <div className="flex items-center gap-2 mb-2">
                  <Bot className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-sm font-semibold">MCP / x402</span>
                </div>
                <p className="text-xs text-muted-foreground mb-3">No account needed. Discover, pay, anchor — one session.</p>
                <Button asChild variant="outline" size="sm" data-testid="button-quickstart-agent-context">
                  <a href="/agent-context">Agent guide <ArrowRight className="ml-1 h-3 w-3" /></a>
                </Button>
              </div>
              <div className="rounded-md border bg-muted/20 p-4" data-testid="card-quickstart-ui">
                <div className="flex items-center gap-2 mb-2">
                  <Upload className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-sm font-semibold">Web UI</span>
                </div>
                <p className="text-xs text-muted-foreground mb-3">Connect wallet, drag a file, get a proof. No code.</p>
                <Button variant="outline" size="sm" onClick={() => handleConnect()} data-testid="button-quickstart-connect">
                  Connect wallet <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>
      {/* Machine Economy Stack */}
      <section className="border-t bg-muted/20 py-12 md:py-16">
        <div className="container">
          <div className="mx-auto max-w-4xl">
            <p className="mb-8 text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              MultiversX Machine Economy Stack
            </p>
            {/* Desktop: horizontal row with arrows */}
            <div className="hidden sm:flex items-stretch gap-0">
              {[
                { id: "MX-8004", label: "Identity", desc: "Who is the agent?" },
                { id: "AP2", label: "Authority", desc: "Is it authorised?" },
                { id: "MCP", label: "Communication", desc: "What did it request?" },
                { id: "x402", label: "Payments", desc: "What did it pay?" },
                { id: "Prove Before Act", label: "Verifiable Intent", desc: "Why did it act?", highlight: true },
              ].map((pillar, i) => (
                <div key={pillar.id} className="flex items-center flex-1 min-w-0">
                  {i > 0 && (
                    <ChevronRight className="h-4 w-4 text-muted-foreground/30 shrink-0 mx-1" />
                  )}
                  <div
                    className={`flex-1 flex flex-col items-center text-center px-3 py-5 rounded-md border h-full ${
                      pillar.highlight
                        ? "border-primary bg-primary/5"
                        : "border-border/60 bg-background/60"
                    }`}
                    data-testid={`stack-pillar-${pillar.id}`}
                  >
                    <span
                      className={`text-sm font-bold font-mono tracking-tight ${
                        pillar.highlight ? "text-primary" : "text-foreground"
                      }`}
                    >
                      {pillar.id}
                    </span>
                    <span
                      className={`text-xs font-semibold mt-1 ${
                        pillar.highlight ? "text-primary/80" : "text-muted-foreground"
                      }`}
                    >
                      {pillar.label}
                    </span>
                    <span className="mt-1.5 text-xs text-muted-foreground/70 leading-snug">
                      {pillar.desc}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {/* Mobile: vertical stack */}
            <div className="flex flex-col gap-2 sm:hidden">
              {[
                { id: "MX-8004", label: "Identity", desc: "Who is the agent?" },
                { id: "AP2", label: "Authority", desc: "Is it authorised?" },
                { id: "MCP", label: "Communication", desc: "What did it request?" },
                { id: "x402", label: "Payments", desc: "What did it pay?" },
                { id: "Prove Before Act", label: "Verifiable Intent", desc: "Why did it act?", highlight: true },
              ].map((pillar) => (
                <div
                  key={pillar.id}
                  className={`flex items-center gap-3 px-4 py-3 rounded-md border ${
                    pillar.highlight
                      ? "border-primary bg-primary/5"
                      : "border-border/60 bg-background/60"
                  }`}
                  data-testid={`stack-pillar-${pillar.id}`}
                >
                  <span className={`text-sm font-bold font-mono tracking-tight w-16 shrink-0 ${pillar.highlight ? "text-primary" : "text-foreground"}`}>
                    {pillar.id}
                  </span>
                  <div className="min-w-0">
                    <span className={`text-xs font-semibold block ${pillar.highlight ? "text-primary/80" : "text-muted-foreground"}`}>
                      {pillar.label}
                    </span>
                    <span className="text-xs text-muted-foreground/70">
                      {pillar.desc}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-8 text-center text-sm text-muted-foreground">
              Prove Before Act is the accountability pattern.{" "}
              <span className="text-foreground font-medium">xProof is its reference implementation for independently verifiable evidence.</span>
            </p>
          </div>
        </div>
      </section>
      {/* Use-cases */}
      <section className="border-t py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="mb-10 text-center">
              <Badge variant="outline" className="mb-4">Use cases</Badge>
              <h2 className="mb-2 text-2xl md:text-3xl font-bold">One pattern, every agent type</h2>
              <p className="text-sm text-muted-foreground max-w-lg mx-auto">Hash → anchor → act. The same loop works for trading, research, support, and orchestration fleets.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {/* Trading */}
              <div className="rounded-md border bg-muted/20 p-5" data-testid="card-usecase-trading">
                <div className="flex items-center gap-2 mb-1">
                  <BarChart3 className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-sm font-bold">Trading Agent</span>
                  <Badge variant="secondary" className="text-xs ml-auto">High value</Badge>
                </div>
                <p className="text-xs text-muted-foreground mb-3">Prove the declared decision basis behind every trade <em>before</em> execution — an independently verifiable audit trail for regulators.</p>
                <pre className="rounded bg-muted/60 border border-border/40 p-3 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre">{`# Anchor before executing the trade
proof = xproof.certify(
  file_hash=sha256(strategy_json),
  metadata={"why": "RSI=38, risk approved",
            "what": "BUY BTC 0.5 @ $67k"}
)
if not proof: raise PolicyError("no proof = no trade")`}</pre>
              </div>
              {/* Research */}
              <div className="rounded-md border bg-muted/20 p-5" data-testid="card-usecase-research">
                <div className="flex items-center gap-2 mb-1">
                  <Terminal className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-sm font-bold">Research Agent</span>
                  <Badge variant="secondary" className="text-xs ml-auto">Attribution</Badge>
                </div>
                <p className="text-xs text-muted-foreground mb-3">Anchor the declared decision basis + sources before publishing — readers can verify the report has not been altered.</p>
                <pre className="rounded bg-muted/60 border border-border/40 p-3 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre">{`# Anchor before publishing the report
proof = xproof.certify(
  file_hash=sha256(report_json),
  metadata={"why": "12 peer-reviewed sources",
            "what": "Climate model v3 — final"}
)
report.set_verify_url(proof["verify_url"])`}</pre>
              </div>
              {/* Support */}
              <div className="rounded-md border bg-muted/20 p-5" data-testid="card-usecase-support">
                <div className="flex items-center gap-2 mb-1">
                  <Zap className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-sm font-bold">Customer Support Agent</span>
                  <Badge variant="secondary" className="text-xs ml-auto">Compliance</Badge>
                </div>
                <p className="text-xs text-muted-foreground mb-3">Every AI response anchored — full audit trail for disputes, GDPR requests, or quality review.</p>
                <pre className="rounded bg-muted/60 border border-border/40 p-3 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre">{`# One line per response in your support loop
for response in agent_responses:
  xproof.certify(
    file_hash=sha256(response),
    metadata={"session": session_id,
              "model": "gpt-4o"}
  )`}</pre>
              </div>
              {/* Fleet */}
              <div className="rounded-md border bg-muted/20 p-5" data-testid="card-usecase-fleet">
                <div className="flex items-center gap-2 mb-1">
                  <Network className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-sm font-bold">Multi-agent Orchestration</span>
                  <Badge variant="secondary" className="text-xs ml-auto">Fleet</Badge>
                </div>
                <p className="text-xs text-muted-foreground mb-3">One proof layer for 50+ agents. Batch up to 50 actions per call — cost per 1,000 anchors is calculated from the current live rate at <code>/api/pricing</code>.</p>
                <pre className="rounded bg-muted/60 border border-border/40 p-3 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre">{`# Batch: up to 50 actions per call
proofs = xproof.certify_batch([
  {"file_hash": sha256(action1),
   "filename": "agent-01-trade.json"},
  {"file_hash": sha256(action2),
   "filename": "agent-02-report.json"},
])  # → [{"proof_id": "prf_..."}, ...]`}</pre>
              </div>
            </div>
            <div className="mt-6 text-center">
              <Button asChild variant="outline" size="sm" data-testid="button-usecases-agent-context">
                <a href="/agent-context">
                  Full integration guide + production patterns
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>
      {/* Prove Before Act + x402 Section */}
      <section id="prove-before-act" className="py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            {/* Prove Before Act */}
            <div className="mb-12">
              <div className="mb-8 text-center">
                <Badge variant="outline" className="mb-4 gap-1.5">
                  <Play className="h-3 w-3 text-primary" />
                  Prove Before Act
                </Badge>
                <h2 className="mb-3 text-2xl md:text-3xl font-bold">
                  The canonical agent accountability loop
                </h2>
                <p className="text-muted-foreground max-w-xl mx-auto text-sm">
                  Anchor the agent&apos;s declared decision basis (WHY) <em>before</em> executing. Anchor the actual result (WHAT) after. Full 4W evidence trail — available to auditors, regulators, or any other agent.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-0 sm:gap-0">
                {[
                  { step: "1", label: "Decide", desc: "Agent declares its decision basis + intent (WHY)", icon: Bot },
                  { step: "2", label: "Anchor WHY", desc: "Hash → anchor on-chain before acting", icon: Blocks },
                  { step: "3", label: "Execute", desc: "Action proceeds with immutable WHY reference", icon: Play },
                  { step: "4", label: "Anchor WHAT", desc: "Certify actual result after execution", icon: Shield },
                ].map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <div key={s.step} className="flex items-center flex-1 min-w-0 w-full sm:w-auto">
                      {i > 0 && (
                        <ChevronRight className="h-4 w-4 text-muted-foreground/30 shrink-0 mx-1 hidden sm:block" />
                      )}
                      <div className="flex-1 flex flex-col items-center text-center px-4 py-4 rounded-md border border-border/60 bg-background/60 h-full min-w-0" data-testid={`prove-step-${s.step}`}>
                        <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                          <Icon className="h-4 w-4 text-primary" />
                        </div>
                        <span className="text-xs font-bold text-foreground">{s.label}</span>
                        <span className="text-xs text-muted-foreground/70 mt-0.5 leading-snug">{s.desc}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-5 text-center">
                <Button asChild variant="outline" size="sm" data-testid="button-prove-before-act-learn">
                  <a href="/agent-context#workflow">
                    Copy-paste Python implementation
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            </div>

            {/* x402: pay without API key */}
            <div className="rounded-md border border-primary/20 bg-primary/5 p-6 md:p-8" data-testid="section-x402">
              <div className="flex flex-col md:flex-row gap-6 items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                      <Zap className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <span className="text-sm font-bold text-primary font-mono">x402</span>
                      <span className="ml-2 text-sm font-semibold">Pay without an API key</span>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                    An agent with a wallet but no Prove Before Act account can anchor its first proof in a single HTTP session. No registration, no browser, no human in the loop. The agent discovers the price, signs a USDC micro-payment on Base, and gets the proof.
                  </p>
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    {["No API key", "USDC on Base", "eip155:8453", `${price} / proof`, "Coinbase CDP compatible"].map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                    ))}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <pre className="text-xs font-mono bg-background/60 border border-border/50 rounded-md p-3 leading-relaxed overflow-x-auto whitespace-pre text-foreground/80">
{`# 1. Send without auth → get HTTP 402 with price
POST /api/proof → 402 {"payment": {"amount": "10000", "currency": "USDC"}}

# 2. Sign USDC payment on Base (eip155:8453)
# 3. Resend with X-PAYMENT header → get proof instantly
POST /api/proof + X-PAYMENT: <signed> → 200 {"proof_id": "..."}`}
                  </pre>
                  <div className="mt-3 flex gap-2">
                    <Button asChild variant="outline" size="sm" data-testid="button-x402-learn">
                      <a href="/agent-context#x402">
                        Full x402 guide
                        <ArrowRight className="ml-1.5 h-3 w-3" />
                      </a>
                    </Button>
                    <Button asChild variant="ghost" size="sm" data-testid="button-x402-docs">
                      <a href="/docs">REST docs</a>
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      {/* How It Works */}
      <section id="how-it-works" className="border-y bg-muted/30 py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="mb-16 text-center">
              <Badge variant="outline" className="mb-4">How it works</Badge>
              <h2 className="mb-4 text-3xl md:text-4xl font-bold">Decide. Prove. Act.</h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Commit the decision basis before execution. A reviewer can inspect the proof and the recorded outcome.
              </p>
            </div>
            
            <div className="grid gap-8 md:grid-cols-3">
              <div className="relative text-center md:text-left">
                <div className="mb-6 mx-auto md:mx-0 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">
                  1
                </div>
                <h3 className="mb-3 text-xl font-semibold">Declare the decision</h3>
                <p className="text-muted-foreground">
                  State what your agent plans to do and the decision basis a reviewer should be able to inspect.
                </p>
                <div className="hidden md:block absolute top-8 left-[calc(100%-20px)] w-[calc(100%-40px)]">
                  <ArrowRight className="h-6 w-6 text-muted-foreground/30" />
                </div>
              </div>

              <div className="relative text-center md:text-left">
                <div className="mb-6 mx-auto md:mx-0 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">
                  2
                </div>
                <h3 className="mb-3 text-xl font-semibold">Commit before execution</h3>
                <p className="text-muted-foreground">
                  Hash the declaration locally and submit it with one API call. Check its independent confirmation before acting.
                </p>
                <div className="hidden md:block absolute top-8 left-[calc(100%-20px)] w-[calc(100%-40px)]">
                  <ArrowRight className="h-6 w-6 text-muted-foreground/30" />
                </div>
              </div>

              <div className="text-center md:text-left">
                <div className="mb-6 mx-auto md:mx-0 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">
                  3
                </div>
                <h3 className="mb-3 text-xl font-semibold">Act, then record the outcome</h3>
                <p className="text-muted-foreground">
                  Once the commitment is confirmed, execute the action and link its outcome to the public proof.
                </p>
              </div>
            </div>

            <div className="mt-12 text-center">
              <Button 
                asChild
                size="lg"
                data-testid="button-try-now"
              >
                <a href="#free-trial">
                  Try it with your agent
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>
      {/* Pricing */}
      <section id="pricing" className="border-y bg-muted/30 py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-3xl">
            <div className="mb-12 text-center">
              <Badge variant="outline" className="mb-4">Simple pricing</Badge>
              <h2 className="mb-4 text-3xl md:text-4xl font-bold">
                One price. No subscription.
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Pay only for what you use. No hidden fees, no commitment.
              </p>
            </div>
            
            <Card className="border-primary shadow-lg max-w-md mx-auto">
              <CardContent className="pt-8 pb-8">
                <div className="text-center mb-6">
                  <div className="mb-2">
                    <span className="text-5xl font-bold" data-testid="text-price">{price}</span>
                  </div>
                  <p className="text-muted-foreground">
                    per proof
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Flat rate. No tiers, no subscription.</p>
                </div>
                <ul className="mb-8 space-y-3 text-sm">
                  <li className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                    <span><strong>Unlimited proofs</strong></span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                    <span>Public proof_id and blockchain transaction URL</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                    <span>Public verification page</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                    <span>Optional PDF export with QR shortcut</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                    <span>MultiversX blockchain</span>
                  </li>
                </ul>
                <Button 
                  className="w-full" 
                  size="lg"
                  onClick={() => handleConnect()}
                  data-testid="button-start-now"
                >
                  Get started
                </Button>
              </CardContent>
            </Card>
            
            <p className="mt-8 text-center text-sm text-muted-foreground">Payment in $EGLD or USDC.</p>
          </div>
        </div>
      </section>
      {/* Universal Compatibility */}
      <section id="integrations" className="py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="mb-16 text-center">
              <Badge variant="outline" className="mb-4">Universal compatibility</Badge>
              <h2 className="mb-4 text-3xl md:text-4xl font-bold">
                Works everywhere agents work.
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                One proof layer, every protocol. From autonomous agents to CI/CD pipelines.
              </p>
            </div>
            
            <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
              {[
                { icon: Blocks, name: "MCP", desc: "Model Context Protocol" },
                { icon: CreditCard, name: "x402", desc: "HTTP-native payments" },
                { icon: ShoppingCart, name: "ACP", desc: "Agent Commerce" },
                { icon: Award, name: "MX-8004", desc: "Trustless Agents" },
                { icon: Bot, name: "OpenClaw", desc: "Skill Marketplace" },
                { icon: Cog, name: "GitHub Action", desc: "CI/CD Pipeline" },
              ].map((item) => (
                <Card key={item.name} className="text-center">
                  <CardContent className="pt-6 pb-4">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <item.icon className="h-5 w-5 text-primary" />
                    </div>
                    <p className="font-semibold text-sm" data-testid={`text-protocol-${item.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`}>{item.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">{item.desc}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            
            <div className="mt-10 text-center">
              <Button asChild variant="outline" data-testid="button-view-integrations">
                <a href="/agents">
                  View all integrations
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>
      {/* x402 / Base Demo */}
      <section id="x402" className="border-y bg-muted/30 py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="mb-16 text-center">
              <Badge variant="outline" className="mb-4">Base Network · x402</Badge>
              <h2 className="mb-4 text-3xl md:text-4xl font-bold">
                Agents pay natively.<br className="hidden md:block" /> No signup, no API key.
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Any x402-compatible agent anchors proofs in one round-trip. The current rate is {price} in USDC on Base (see <code>/api/pricing</code>). No account required.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {/* Step 1 */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">1</div>
                  <h3 className="font-semibold">Submit proof</h3>
                </div>
                <p className="text-sm text-muted-foreground pl-11">Agent sends a POST with no credentials.</p>
                <div className="rounded-md bg-[#0d1117] p-4 font-mono text-xs text-[#e6edf3] overflow-x-auto" data-testid="code-x402-step1">
                  <div className="text-[#8b949e] mb-2"># No API key, no auth</div>
                  <div><span className="text-[#79c0ff]">POST</span> <span className="text-[#a5d6ff]">https://provebeforeact.com/api/proof</span></div>
                  <div className="text-[#8b949e] mt-2 mb-1">Content-Type: application/json</div>
                  <div className="mt-1">{`{`}</div>
                  <div className="pl-4"><span className="text-[#79c0ff]">"file_hash"</span><span className="text-[#e6edf3]">: </span><span className="text-[#a5d6ff]">"sha256..."</span><span className="text-[#e6edf3]">,</span></div>
                  <div className="pl-4"><span className="text-[#79c0ff]">"filename"</span><span className="text-[#e6edf3]">: </span><span className="text-[#a5d6ff]">"report.pdf"</span></div>
                  <div>{`}`}</div>
                </div>
              </div>

              {/* Step 2 */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">2</div>
                  <h3 className="font-semibold">Receive payment challenge</h3>
                </div>
                <p className="text-sm text-muted-foreground pl-11">Prove Before Act replies with payment terms on Base.</p>
                <div className="rounded-md bg-[#0d1117] p-4 font-mono text-xs text-[#e6edf3] overflow-x-auto" data-testid="code-x402-step2">
                  <div><span className="text-[#f85149]">HTTP 402</span> <span className="text-[#8b949e]">Payment Required</span></div>
                  <div className="mt-2">{`{`}</div>
                  <div className="pl-4"><span className="text-[#79c0ff]">"x402Version"</span><span className="text-[#e6edf3]">: </span><span className="text-[#ffa657]">1</span><span className="text-[#e6edf3]">,</span></div>
                  <div className="pl-4"><span className="text-[#79c0ff]">"accepts"</span><span className="text-[#e6edf3]">: [{`{`}</span></div>
                  <div className="pl-8"><span className="text-[#79c0ff]">"price"</span><span className="text-[#e6edf3]">: </span><span className="text-[#a5d6ff]">"{price}"</span><span className="text-[#e6edf3]">,</span></div>
                  <div className="pl-8"><span className="text-[#79c0ff]">"network"</span><span className="text-[#e6edf3]">: </span><span className="text-[#a5d6ff]">"eip155:8453"</span><span className="text-[#e6edf3]">,</span></div>
                  <div className="pl-8"><span className="text-[#79c0ff]">"asset"</span><span className="text-[#e6edf3]">: </span><span className="text-[#a5d6ff]">"USDC"</span></div>
                  <div className="pl-4"><span className="text-[#e6edf3]">{`}]`}</span></div>
                  <div>{`}`}</div>
                </div>
              </div>

              {/* Step 3 */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">3</div>
                  <h3 className="font-semibold">Pay & get proof</h3>
                </div>
                <p className="text-sm text-muted-foreground pl-11">Agent retries with payment receipt — gets blockchain proof.</p>
                <div className="rounded-md bg-[#0d1117] p-4 font-mono text-xs text-[#e6edf3] overflow-x-auto" data-testid="code-x402-step3">
                  <div className="text-[#8b949e] mb-2"># Retry with USDC payment</div>
                  <div><span className="text-[#79c0ff]">POST</span> <span className="text-[#a5d6ff]">https://provebeforeact.com/api/proof</span></div>
                  <div className="text-[#8b949e] mt-2">X-Payment: <span className="text-[#e6edf3]">eyJ...</span></div>
                  <div className="mt-2 text-[#3fb950]">HTTP 200 OK</div>
                  <div className="mt-1">{`{`}</div>
                  <div className="pl-4"><span className="text-[#79c0ff]">"proof_id"</span><span className="text-[#e6edf3]">: </span><span className="text-[#a5d6ff]">"prf_..."</span><span className="text-[#e6edf3]">,</span></div>
                  <div className="pl-4"><span className="text-[#79c0ff]">"tx_hash"</span><span className="text-[#e6edf3]">: </span><span className="text-[#a5d6ff]">"0xab..."</span><span className="text-[#e6edf3]">,</span></div>
                  <div className="pl-4"><span className="text-[#79c0ff]">"verify_url"</span><span className="text-[#e6edf3]">: </span><span className="text-[#a5d6ff]">"provebeforeact.com/..."</span></div>
                  <div>{`}`}</div>
                </div>
              </div>
            </div>

            {/* Python implementation — copy-paste ready */}
            <div className="mt-10 rounded-md bg-[#0d1117] overflow-hidden" data-testid="code-x402-python">
              <div className="flex items-center justify-between px-4 py-2 border-b border-[#30363d]">
                <span className="text-xs text-[#8b949e] font-mono">Python — complete x402 implementation</span>
                <Badge variant="outline" className="text-xs font-mono border-[#30363d] text-[#8b949e]">copy-paste ready</Badge>
              </div>
              <div className="p-4 font-mono text-xs text-[#e6edf3] overflow-x-auto leading-relaxed">
                <div className="text-[#8b949e]">import hashlib, json, base64, requests</div>
                <div className="mt-3"><span className="text-[#f97583]">def</span> <span className="text-[#b392f0]">anchor_x402</span><span className="text-[#e6edf3]">(reasoning: dict, wallet_signer) -&gt; dict:</span></div>
                <div className="pl-4 text-[#8b949e]">"""Prove Before Act — anchor a declared decision basis, then execute."""</div>
                <div className="pl-4 mt-2 text-[#8b949e]"># 1. Hash locally — nothing sensitive leaves this function</div>
                <div className="pl-4"><span className="text-[#e3b341]">file_hash</span> = hashlib.sha256(json.dumps(reasoning, sort_keys=<span className="text-[#79c0ff]">True</span>).encode()).hexdigest()</div>
                <div className="pl-4 mt-2 text-[#8b949e]"># 2. POST without auth → HTTP 402 with price + payment terms</div>
                <div className="pl-4"><span className="text-[#e3b341]">r</span> = requests.post(<span className="text-[#a5d6ff]">"https://provebeforeact.com/api/proof"</span>, json=&#123;<span className="text-[#a5d6ff]">"file_hash"</span>: file_hash&#125;)</div>
                <div className="pl-4"><span className="text-[#f97583]">assert</span> r.status_code == <span className="text-[#ffa657]">402</span>  <span className="text-[#8b949e]"># ← this is the x402 challenge</span></div>
                <div className="pl-4 mt-2 text-[#8b949e]"># 3. Sign USDC on Base (eip155:8453) via your wallet adapter</div>
                <div className="pl-4"><span className="text-[#e3b341]">signed</span> = wallet_signer.sign_x402(r.json()[<span className="text-[#a5d6ff]">"payment"</span>])</div>
                <div className="pl-4"><span className="text-[#e3b341]">x_payment</span> = base64.b64encode(json.dumps(signed).encode()).decode()</div>
                <div className="pl-4 mt-2 text-[#8b949e]"># 4. Resend with X-PAYMENT header → proof_id returned immediately</div>
                <div className="pl-4"><span className="text-[#e3b341]">proof</span> = requests.post(<span className="text-[#a5d6ff]">"https://provebeforeact.com/api/proof"</span>,</div>
                <div className="pl-8">headers=&#123;<span className="text-[#a5d6ff]">"X-PAYMENT"</span>: x_payment&#125;, json=&#123;<span className="text-[#a5d6ff]">"file_hash"</span>: file_hash&#125;)</div>
                <div className="pl-4 mt-2"><span className="text-[#f97583]">return</span> proof.json()  <span className="text-[#8b949e]"># &#123; proof_id, verify_url &#125;</span></div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {["USDC", "Base Mainnet", "eip155:8453", "No account needed", `${price} / proof`].map((label) => (
                <Badge key={label} variant="outline" className="text-xs font-mono" data-testid={`badge-x402-${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}>{label}</Badge>
              ))}
            </div>

            <div className="mt-10 rounded-md border border-primary/20 bg-primary/5 p-4 text-center">
              <p className="text-sm font-semibold mb-1">Prove Before Act = the standard for agents that take accountability seriously.</p>
              <p className="text-xs text-muted-foreground mb-4">
                Any agent with a Base wallet can anchor its first proof in one HTTP round-trip — no account, no human, no signup. x402 is proof that the machine economy doesn't need intermediaries.
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                <Button asChild variant="outline" size="sm" data-testid="button-x402-agent-context">
                  <a href="/agent-context#x402">
                    Full x402 guide for agents
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </a>
                </Button>
                <Button asChild variant="ghost" size="sm" data-testid="button-x402-try">
                  <a href="/#free-trial">10 free proofs — start now</a>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>
      {/* FAQ */}
      <section id="faq" className="py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-3xl">
            <div className="mb-12 text-center">
              <Badge variant="outline" className="mb-4">FAQ</Badge>
              <h2 className="mb-4 text-3xl md:text-4xl font-bold">
                Frequently asked questions
              </h2>
            </div>
            
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="item-1">
                <AccordionTrigger className="text-left" data-testid="faq-trigger-upload">
                  Is my file uploaded to your servers?
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  No. Only the SHA-256 hash is transmitted. Source data never leaves the agent&apos;s runtime environment.
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="item-2">
                <AccordionTrigger className="text-left" data-testid="faq-trigger-blockchain">
                  What is the MultiversX blockchain?
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  MultiversX is a high-performance, eco-friendly European blockchain. 
                  Unlike Bitcoin, it consumes very little energy. It's a global public ledger, 
                  impossible to modify or delete, perfect for legal proofs.
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="item-3">
                <AccordionTrigger className="text-left" data-testid="faq-trigger-legal">
                  Does it have legal value?
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  Yes. Blockchain timestamping is recognized in many jurisdictions as 
                  proof of prior existence. It proves that your file existed at a specific date, 
                  which is essential in intellectual property disputes.
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="item-4">
                <AccordionTrigger className="text-left" data-testid="faq-trigger-modify">
                  What happens if I modify my file?
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  The slightest change (even a single pixel) generates a completely different SHA-256 hash.
                  This is what guarantees integrity: if someone modifies your file, 
                  it will no longer match the original proof.
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="item-5">
                <AccordionTrigger className="text-left" data-testid="faq-trigger-verify">
                  How can someone verify my proof?
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  Each proof has a public <code className="text-xs">proof_id</code> and blockchain transaction URL.
                  An optional PDF export can include a QR shortcut to that verification URL,
                  so anyone can inspect the proof details and verify directly on-chain.
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="item-6">
                <AccordionTrigger className="text-left" data-testid="faq-trigger-wallet">
                  Why do I need a crypto wallet?
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  The wallet is used to securely identify you and to sign 
                  your proofs. It works like an ultra-secure electronic signature. 
                  You can use the MultiversX DeFi Wallet browser extension.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </div>
      </section>
      {/* Final CTA */}
      <section className="border-t bg-primary/5 py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="mb-4 text-3xl md:text-4xl font-bold">
              Start anchoring trust
            </h2>
            <p className="mb-8 text-lg text-muted-foreground">
              Verifiable proofs for developers, agents, and enterprises. {price} per proof.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button
                asChild
                size="lg"
                className="text-base h-12 px-8"
                data-testid="button-final-cta-trial"
              >
                <a href="#free-trial">
                  <Key className="mr-2 h-5 w-5" />
                  Start free — no wallet
                </a>
              </Button>
              <Button 
                size="lg" 
                variant="outline"
                className="text-base h-12 px-8"
                onClick={() => handleConnect()}
                data-testid="button-final-cta"
              >
                <Shield className="mr-2 h-5 w-5" />
                Connect wallet
              </Button>
            </div>
          </div>
        </div>
      </section>
      </main>
      <PublicSiteFooter />
      <WalletLoginModal 
        open={isLoginModalOpen} 
        onOpenChange={setIsLoginModalOpen} 
        redirectTo={loginRedirectTo}
      />
    </div>
  );
}
