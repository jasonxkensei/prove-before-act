import { useState, useRef } from "react";
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
import { trackAgentCta, useAgentCtaExposure } from "@/lib/conversionTracking";
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

function QuickStartCode({ onGetKey }: { onGetKey: () => void }) {
  const [lang, setLang] = useState<"python" | "typescript" | "curl">("python");
  const [copied, setCopied] = useState(false);
  const code = QUICKSTART_SNIPPETS[lang];

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
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
            onClick={() => setLang(l)}
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
  const { data: pricing } = useQuery<{
    current_price_usd: number;
    total_certifications: number;
  }>({
    queryKey: ["/api/pricing"],
  });
  const price = pricing ? `$${pricing.current_price_usd}` : "$0.01";

  const [agentName, setAgentName] = useState("");
  const [trialKey, setTrialKey] = useState<string | null>(null);
  const [trialAgentName, setTrialAgentName] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const heroTrialCtaRef = useAgentCtaExposure<HTMLAnchorElement>("landing", "hero_free_trial");

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
      setTrialError(null);
    },
    onError: (err: Error) => {
      setTrialError(err.message);
    },
  });

  const handleCopyKey = () => {
    if (!trialKey) return;
    navigator.clipboard.writeText(trialKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConnect = () => {
    setIsLoginModalOpen(true);
  };

  // — Live proof widget state —
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofHash, setProofHash] = useState<string>("");
  const [isHashing, setIsHashing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [proofResult, setProofResult] = useState<{
    proof_id?: string | number;
    verify_url?: string;
    blockchain?: { transaction_hash?: string; explorer_url?: string };
    trial?: { remaining?: number };
  } | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);

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
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Proof submission failed. Please try again.");
      return data;
    },
    onSuccess: (data) => {
      setProofResult(data);
      setProofError(null);
    },
    onError: (err: Error) => {
      setProofError(err.message);
    },
  });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2" data-testid="link-logo-home">
            <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
          </a>
          <nav className="hidden md:flex items-center gap-6">
            <a href="#how-it-works" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-how-it-works">
              How it works
            </a>
            <a href="/leaderboard" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-leaderboard">
              Leaderboard
            </a>
            <a href="/stats" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-metrics">
              Metrics
            </a>
            <a href="/docs" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-docs">
              Docs
            </a>
            <a href="/agent-context" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1" data-testid="link-nav-agent-context">
              <Bot className="h-3.5 w-3.5" />
              For Agents
            </a>
            <a href="/coherence" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-coherence">
              Coherence
            </a>
            <a href="#faq" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-nav-faq">
              FAQ
            </a>
            <a
              href="#free-trial"
              className="text-sm font-medium text-primary bg-primary/10 hover:bg-primary/20 border border-primary/20 rounded-md px-3 py-1.5 transition-colors"
              data-testid="link-nav-start-free"
            >
              Start free
            </a>
          </nav>
          <div className="flex items-center gap-3">
            <a
              href="#free-trial"
              className="text-sm font-medium text-primary bg-primary/10 hover:bg-primary/20 border border-primary/20 rounded-md px-3 py-1.5 transition-colors md:hidden"
              data-testid="link-nav-start-free-mobile"
            >
              Start free
            </a>
            <a
              href="/zh"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors border border-border/50 rounded-md px-2.5 py-1.5 font-mono"
              data-testid="link-lang-zh"
            >
              中文
            </a>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleConnect}
              data-testid="button-login"
            >
              <Wallet className="mr-2 h-4 w-4" />
              Connect
            </Button>
          </div>
        </div>
      </header>
      {/* Hero Section */}
      <section className="container pt-14 pb-20 md:pt-20 md:pb-28">
        <div className="mx-auto max-w-5xl text-center">
          <div className="mb-5 flex justify-center">
            <Badge variant="outline" className="text-xs px-3 py-1 gap-1.5" data-testid="badge-prove-before-act">
              <Play className="h-3 w-3 text-primary" />
              Prove Before Act — anchor reasoning before executing
            </Badge>
          </div>

          <h1 className="mb-3 text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-tight">
            Prove Before Act
            <br />
            <span className="text-primary">accountability for&nbsp;agents.</span>
          </h1>

          <p className="mx-auto mb-8 max-w-2xl text-lg md:text-xl text-muted-foreground leading-relaxed">
            Anchor your agent's reasoning on-chain before it executes.{" "}
            {price}/proof · 10 free certs · no wallet needed.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button
              asChild
              size="lg"
              className="text-base h-12 px-8"
              data-testid="button-free-trial-hero"
            >
              <a
                href="/agents"
                ref={heroTrialCtaRef}
                onClick={() => trackAgentCta("cta_clicked", "landing", "hero_free_trial")}
              >
                <Bot className="mr-2 h-4 w-4" />
                Get started — agents
              </a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="text-base h-12 px-8"
              data-testid="button-certify-file"
            >
              <a href="/certify">
                <Upload className="mr-2 h-5 w-5" />
                Certify a file
              </a>
            </Button>
          </div>

          <p className="mt-4 text-sm text-muted-foreground font-mono">
            Register free → Get key → First proof in 1 curl
          </p>

          {/* x402 callout — above the fold */}
          <div className="mt-6 flex justify-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-4 py-1.5 text-sm" data-testid="badge-x402-hero">
              <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="text-muted-foreground">No API key needed — anchor + pay via <strong className="text-foreground">x402</strong> · one HTTP request · USDC on Base</span>
            </div>
          </div>

        </div>
      </section>
      {/* Free Trial — Interactive Registration */}
      <section id="free-trial" className="border-y bg-muted/30 py-16 md:py-20">
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
                      if (e.key === "Enter" && agentName.trim().length >= 2) {
                        registerMutation.mutate(agentName.trim());
                      }
                    }}
                    data-testid="input-trial-agent-name"
                    className="flex-1"
                  />
                  <Button
                    onClick={() => {
                      trackAgentCta("cta_clicked", "landing", "trial_register");
                      registerMutation.mutate(agentName.trim());
                    }}
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
                      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setIsDragging(false);
                        const f = e.dataTransfer.files[0];
                        if (f) handleFileSelect(f);
                      }}
                      onClick={() => fileInputRef.current?.click()}
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
                          <p className="text-sm font-medium text-muted-foreground">Drag any file here, or click to select</p>
                          <p className="text-xs text-muted-foreground/60 mt-1">Your file never leaves your device — only its fingerprint is sent</p>
                        </>
                      ) : (
                        <div className="flex items-center gap-3 justify-center">
                          <File className="h-6 w-6 text-primary shrink-0" />
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium truncate max-w-xs">{proofFile.name}</p>
                            {isHashing ? (
                              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Computing fingerprint…
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
                        onClick={() => submitProofMutation.mutate({ hash: proofHash, filename: proofFile.name })}
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
                  <>
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
                      <Button
                        asChild
                        size="sm"
                        variant="outline"
                        data-testid="button-view-proof"
                      >
                        <a
                          href={proofResult.verify_url || `/proof/${proofResult.proof_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="mr-1.5 h-3 w-3" />
                          View proof
                        </a>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const url = proofResult.verify_url
                            ? `https://provebeforeact.com${proofResult.verify_url.startsWith("/") ? "" : "/"}${proofResult.verify_url}`
                            : `https://provebeforeact.com/proof/${proofResult.proof_id}`;
                          navigator.clipboard.writeText(url);
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
                      <Button size="sm" variant="outline" onClick={handleConnect} data-testid="button-trial-connect-wallet">
                        <Wallet className="mr-1.5 h-3.5 w-3.5" />
                        Connect wallet
                      </Button>
                    </div>
                  </div>
                  </>
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
                  <Button size="sm" variant="ghost" onClick={handleConnect} data-testid="button-trial-connect-wallet">
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
              const el = document.getElementById("free-trial");
              if (el) el.scrollIntoView({ behavior: "smooth" });
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
                <Button variant="outline" size="sm" onClick={handleConnect} data-testid="button-quickstart-connect">
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
              Prove Before Act is the accountability layer.{" "}
              <span className="text-foreground font-medium">Every agent action, proven on-chain.</span>
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
                <p className="text-xs text-muted-foreground mb-3">Prove the reasoning behind every trade <em>before</em> execution — non-repudiable audit trail for regulators.</p>
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
                <p className="text-xs text-muted-foreground mb-3">Anchor reasoning + sources before publishing — readers can verify the report hasn't been altered.</p>
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
                <p className="text-xs text-muted-foreground mb-3">One proof layer for 50+ agents. Batch up to 100 actions per call — $10 per 1,000 anchors.</p>
                <pre className="rounded bg-muted/60 border border-border/40 p-3 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre">{`# Batch: up to 100 actions per call
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
                  Anchor reasoning (WHY) on-chain <em>before</em> executing. Anchor actual result (WHAT) after. Full 4W audit trail — available to auditors, regulators, or any other agent.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-0 sm:gap-0">
                {[
                  { step: "1", label: "Reason", desc: "Agent writes full reasoning + decision (WHY)", icon: Bot },
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
                    {["No API key", "USDC on Base", "eip155:8453", "$0.01 per proof", "Coinbase CDP compatible"].map((tag) => (
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
              <h2 className="mb-4 text-3xl md:text-4xl font-bold">
                One API call. Permanent accountability.
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Integrate Prove Before Act into your agent's execution loop.
                Every decision, output, and action becomes a verifiable on-chain record.
              </p>
            </div>
            
            <div className="grid gap-8 md:grid-cols-3">
              <div className="relative text-center md:text-left">
                <div className="mb-6 mx-auto md:mx-0 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">
                  1
                </div>
                <h3 className="mb-3 text-xl font-semibold">Your agent acts</h3>
                <p className="text-muted-foreground">
                  Your agent makes a decision, produces an output, or executes a task.
                  Before moving on, it hashes that action locally — nothing leaves your infrastructure.
                </p>
                <div className="hidden md:block absolute top-8 left-[calc(100%-20px)] w-[calc(100%-40px)]">
                  <ArrowRight className="h-6 w-6 text-muted-foreground/30" />
                </div>
              </div>

              <div className="relative text-center md:text-left">
                <div className="mb-6 mx-auto md:mx-0 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">
                  2
                </div>
                <h3 className="mb-3 text-xl font-semibold">POST the fingerprint</h3>
                <p className="text-muted-foreground">
                  One API call with a SHA-256 hash and optional metadata — model version, strategy, 
                  confidence level, session ID. Your API key handles authentication. No overhead.
                </p>
                <div className="hidden md:block absolute top-8 left-[calc(100%-20px)] w-[calc(100%-40px)]">
                  <ArrowRight className="h-6 w-6 text-muted-foreground/30" />
                </div>
              </div>

              <div className="text-center md:text-left">
                <div className="mb-6 mx-auto md:mx-0 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">
                  3
                </div>
                <h3 className="mb-3 text-xl font-semibold">Proof anchored on-chain</h3>
                <p className="text-muted-foreground">
                  Prove Before Act anchors the fingerprint on MultiversX and returns a <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">proof_id</code> and a public verification URL.
                  Your entire fleet now has a tamper-proof audit trail.
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
                    <span>Downloadable PDF proof</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                    <span>Public verification page</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                    <span>Verification QR code</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                    <span>MultiversX blockchain</span>
                  </li>
                </ul>
                <Button 
                  className="w-full" 
                  size="lg"
                  onClick={handleConnect}
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
                Any x402-compatible agent anchors proofs in one round-trip. $0.01 in USDC on Base. No account required.
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
                  <div className="pl-8"><span className="text-[#79c0ff]">"price"</span><span className="text-[#e6edf3]">: </span><span className="text-[#a5d6ff]">"$0.01"</span><span className="text-[#e6edf3]">,</span></div>
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
                <div className="pl-4 text-[#8b949e]">"""Prove Before Act — anchor reasoning, then execute."""</div>
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
              {["USDC", "Base Mainnet", "eip155:8453", "No account needed", "$0.01 / proof"].map((label) => (
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
                  No, never. Your file stays on your device. Only its "fingerprint" 
                  (a unique 64-character code) is computed locally and recorded on the blockchain. 
                  Your file remains 100% private.
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
                  The slightest change (even a single pixel) generates a completely different fingerprint. 
                  This is what guarantees integrity: if someone modifies your file, 
                  it will no longer match the original proof.
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="item-5">
                <AccordionTrigger className="text-left" data-testid="faq-trigger-verify">
                  How can someone verify my proof?
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  Each proof contains a QR code and a link to a public verification page. 
                  Anyone can scan the QR or visit the link to see the proof details 
                  and verify directly on the blockchain.
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
                onClick={handleConnect}
                data-testid="button-final-cta"
              >
                <Shield className="mr-2 h-5 w-5" />
                Connect wallet
              </Button>
            </div>
          </div>
        </div>
      </section>
      {/* Footer */}
      <footer className="border-t py-12">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="grid gap-8 md:grid-cols-4 mb-12">
              <div className="md:col-span-2">
                <div className="flex items-center gap-2 mb-4">
                  <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
                </div>
                <p className="text-sm text-muted-foreground max-w-xs">
                  The on-chain notary for AI agents. Verifiable trust, anchored on MultiversX.
                </p>
              </div>
              
              <div>
                <h4 className="font-semibold mb-4">Product</h4>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li><a href="#how-it-works" className="hover:text-foreground transition-colors">How it works</a></li>
                  <li><a href="#faq" className="hover:text-foreground transition-colors">FAQ</a></li>
                  <li><a href="/docs" className="hover:text-foreground transition-colors" data-testid="link-footer-docs">API Docs</a></li>
                  <li><a href="/agents" className="hover:text-foreground transition-colors" data-testid="link-footer-agents">For AI Agents</a></li>
                  <li><a href="/leaderboard" className="hover:text-foreground transition-colors" data-testid="link-footer-leaderboard">Trust Leaderboard</a></li>
                  <li><a href="/stats" className="hover:text-foreground transition-colors" data-testid="link-footer-stats">Metrics</a></li>
                </ul>
              </div>
              
              <div>
                <h4 className="font-semibold mb-4">Legal</h4>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li><a href="/legal/mentions" className="hover:text-foreground transition-colors" data-testid="link-legal-mentions">Legal notices</a></li>
                  <li><a href="/legal/privacy" className="hover:text-foreground transition-colors" data-testid="link-legal-privacy">Privacy policy</a></li>
                  <li><a href="/legal/terms" className="hover:text-foreground transition-colors" data-testid="link-legal-terms">Terms</a></li>
                </ul>
              </div>
            </div>
            
            <div className="border-t pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                © {new Date().getFullYear()} Prove Before Act. All rights reserved.
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Powered by</span>
                <a 
                  href="https://multiversx.com" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="font-medium text-primary hover:underline"
                >
                  MultiversX
                </a>
              </div>
            </div>
          </div>
        </div>
      </footer>
      <WalletLoginModal 
        open={isLoginModalOpen} 
        onOpenChange={setIsLoginModalOpen} 
      />
    </div>
  );
}
