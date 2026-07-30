import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Bot,
  Zap,
  Shield,
  Play,
  Copy,
  CheckCircle,
  ArrowRight,
  ChevronRight,
  Eye,
  Blocks,
  Network,
} from "lucide-react";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="absolute top-3 right-3 p-1.5 rounded bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
    >
      {copied ? (
        <CheckCircle className="h-3.5 w-3.5 text-primary" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function CodeBlock({ code, lang = "bash" }: { code: string; lang?: string }) {
  return (
    <div className="relative mt-3 mb-1">
      <pre className="rounded-md bg-muted/70 border border-border/50 p-4 pr-10 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre text-foreground/90">
        {code}
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

export default function CoherencePage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2">
            <img src="/xproof-logo.png" alt="xproof" className="h-8 w-auto" />
          </a>
          <nav className="hidden md:flex items-center gap-6">
            <a href="/" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Home
            </a>
            <a href="/agent-context" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <Bot className="h-3.5 w-3.5" />
              For Agents
            </a>
            <a href="/docs" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Docs
            </a>
            <a href="/leaderboard" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Leaderboard
            </a>
          </nav>
          <div className="flex items-center gap-3">
            <Button asChild size="sm">
              <a href="/#free-trial">
                Start free
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* ── Hero ──────────────────────────────────────────────────────────── */}
        <section className="container pt-16 pb-20 md:pt-24 md:pb-28">
          <div className="mx-auto max-w-4xl text-center">
            <div className="mb-5 flex justify-center">
              <Badge variant="outline" className="text-xs px-3 py-1 gap-1.5">
                <Play className="h-3 w-3 text-primary" />
                Coherence Layer · xProof v2
              </Badge>
            </div>

            <h1 className="mb-6 text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-tight">
              Intelligence creates possibilities.
              <br />
              <span className="text-primary">Coherence decides which ones matter.</span>
            </h1>

            <p className="mx-auto mb-4 max-w-2xl text-lg md:text-xl text-muted-foreground leading-relaxed">
              Any agent can act. A trustworthy agent can demonstrate{" "}
              <strong className="text-foreground">why it acted</strong>,{" "}
              <strong className="text-foreground">what it decided</strong>, and{" "}
              <strong className="text-foreground">whether its result matched its intent</strong>.
            </p>

            <p className="mx-auto mb-10 max-w-xl text-base text-muted-foreground">
              The Coherence Layer is xProof's natural evolution — from "prove what happened" to
              "maintain alignment between intent, decision, and result."
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button asChild size="lg" className="text-base h-12 px-8">
                <a href="#check-coherence">
                  <Zap className="mr-2 h-4 w-4" />
                  See check_coherence
                </a>
              </Button>
              <Button asChild variant="outline" size="lg" className="text-base h-12 px-8">
                <a href="/agent-context">
                  <Bot className="mr-2 h-4 w-4" />
                  Agent integration guide
                </a>
              </Button>
            </div>
          </div>
        </section>

        {/* ── The Gap ───────────────────────────────────────────────────────── */}
        <section className="border-t bg-muted/20 py-16 md:py-20">
          <div className="container">
            <div className="mx-auto max-w-4xl">
              <div className="mb-10 text-center">
                <Badge variant="outline" className="mb-4">The problem</Badge>
                <h2 className="mb-3 text-2xl md:text-3xl font-bold">
                  Every autonomous system has the same gap
                </h2>
                <p className="text-muted-foreground max-w-2xl mx-auto">
                  The distance between what was intended, what was understood, what was decided,
                  and what was proven — that gap is where trust breaks down.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                {[
                  { label: "What was intended", icon: Eye, color: "border-primary/30 bg-primary/5", textColor: "text-primary" },
                  { label: "What was understood", icon: Blocks, color: "border-border/60 bg-muted/30", textColor: "text-foreground" },
                  { label: "What was decided", icon: Shield, color: "border-border/60 bg-muted/30", textColor: "text-foreground" },
                  { label: "What can be proven", icon: CheckCircle, color: "border-emerald-500/30 bg-emerald-500/5", textColor: "text-emerald-500 dark:text-emerald-400" },
                ].map((item, i) => {
                  const Icon = item.icon;
                  return (
                    <div key={i} className="flex items-center min-w-0">
                      {i > 0 && (
                        <ChevronRight className="h-4 w-4 text-muted-foreground/30 shrink-0 mr-2 hidden sm:block" />
                      )}
                      <div className={`flex-1 rounded-md border ${item.color} p-4 text-center`}>
                        <Icon className={`h-5 w-5 mx-auto mb-2 ${item.textColor}`} />
                        <p className={`text-xs font-semibold ${item.textColor}`}>{item.label}</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-8 rounded-md border border-amber-500/20 bg-amber-500/5 p-5 text-center">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  With human teams, this gap creates misunderstandings and accountability failures.
                  With autonomous agents acting in seconds,{" "}
                  <strong className="text-foreground">this gap becomes a compliance and trust crisis.</strong>
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Prove Before Act loop ─────────────────────────────────────────── */}
        <section className="py-16 md:py-20">
          <div className="container">
            <div className="mx-auto max-w-4xl">
              <div className="mb-10 text-center">
                <Badge variant="outline" className="mb-4 gap-1.5">
                  <Play className="h-3 w-3 text-primary" />
                  Prove Before Act
                </Badge>
                <h2 className="mb-3 text-2xl md:text-3xl font-bold">
                  The canonical accountability loop
                </h2>
                <p className="text-muted-foreground max-w-xl mx-auto">
                  Anchor your WHY on-chain before acting. Anchor your WHAT after.
                  Full 4W audit trail — immutable, public, reconstructible.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch gap-0">
                {[
                  {
                    step: "1",
                    label: "Reason",
                    desc: "Agent writes full reasoning: intent, context, decision",
                    icon: Eye,
                    highlight: false,
                  },
                  {
                    step: "2",
                    label: "Anchor WHY",
                    desc: "check_coherence → hash on-chain as WHY proof",
                    icon: Zap,
                    highlight: true,
                  },
                  {
                    step: "3",
                    label: "Execute",
                    desc: "Action proceeds with immutable WHY reference",
                    icon: Play,
                    highlight: false,
                  },
                  {
                    step: "4",
                    label: "Anchor WHAT",
                    desc: "certify_file → result hash linked to WHY proof",
                    icon: Shield,
                    highlight: false,
                  },
                ].map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <div key={s.step} className="flex items-center flex-1 min-w-0 w-full sm:w-auto">
                      {i > 0 && (
                        <ChevronRight className="h-4 w-4 text-muted-foreground/30 shrink-0 mx-1 hidden sm:block" />
                      )}
                      <div
                        className={`flex-1 flex flex-col items-center text-center px-4 py-5 rounded-md border h-full min-w-0 ${
                          s.highlight
                            ? "border-primary bg-primary/5"
                            : "border-border/60 bg-background/60"
                        }`}
                      >
                        <div
                          className={`mb-2 flex h-8 w-8 items-center justify-center rounded-full ${
                            s.highlight ? "bg-primary/20" : "bg-muted/60"
                          }`}
                        >
                          <Icon className={`h-4 w-4 ${s.highlight ? "text-primary" : "text-muted-foreground"}`} />
                        </div>
                        <span className={`text-xs font-bold ${s.highlight ? "text-primary" : "text-foreground"}`}>
                          {s.label}
                        </span>
                        <span className="text-xs text-muted-foreground/70 mt-1 leading-snug">{s.desc}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 text-center">
                <Button asChild variant="outline" size="sm">
                  <a href="/agent-context#workflow">
                    Full implementation guide (Python + TypeScript)
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* ── check_coherence tool ─────────────────────────────────────────── */}
        <section id="check-coherence" className="border-t bg-muted/20 py-16 md:py-20">
          <div className="container">
            <div className="mx-auto max-w-4xl">
              <div className="mb-10 text-center">
                <Badge variant="outline" className="mb-4 font-mono">check_coherence</Badge>
                <h2 className="mb-3 text-2xl md:text-3xl font-bold">
                  Anchor your WHY before acting
                </h2>
                <p className="text-muted-foreground max-w-xl mx-auto">
                  A single MCP tool call. Pass your intent, context, and decision.
                  Receive an immutable WHY proof on-chain in under 2 seconds.
                </p>
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                {/* MCP tool call */}
                <div>
                  <p className="text-xs font-semibold mb-2 text-muted-foreground uppercase tracking-wide">
                    MCP tool call
                  </p>
                  <CodeBlock
                    lang="json"
                    code={`{
  "name": "check_coherence",
  "arguments": {
    "intent": "Optimize portfolio allocation for this quarter",
    "context": "BTC RSI=38 (oversold), current allocation 2.1% (below 3% cap), volatility_30d=0.42",
    "decision": "BUY 0.5 BTC at market — increases allocation to 2.8%",
    "who": "trading-agent-v2"
  }
}`}
                  />
                </div>

                {/* Response */}
                <div>
                  <p className="text-xs font-semibold mb-2 text-muted-foreground uppercase tracking-wide">
                    Response
                  </p>
                  <CodeBlock
                    lang="json"
                    code={`{
  "proof_id": "prf_coherence_abc123",
  "coherence_anchor": "e3b0c44298fc1c14...",
  "timestamp": "2026-07-30T09:15:02Z",
  "blockchain_status": "pending",
  "verify_url": "/proof/prf_coherence_abc123",
  "metadata": {
    "type": "coherence_check",
    "role": "WHY"
  },
  "next_step": {
    "action": "Execute your decision, then call certify_file",
    "link_why_to_what": "Include proof_id in certify_file metadata.why_proof_id to link WHY→WHAT"
  }
}`}
                  />
                </div>
              </div>

              {/* Full Python example */}
              <div className="mt-8">
                <p className="text-xs font-semibold mb-2 text-muted-foreground uppercase tracking-wide">
                  Full Prove Before Act loop (Python)
                </p>
                <CodeBlock
                  lang="python"
                  code={`import hashlib, json, requests

API_KEY = "pm_YOUR_KEY"
BASE = "https://xproof.app"

def prove_before_act(intent: str, context: str, decision: str, agent_id: str):
    """
    Coherence Layer: anchor WHY before acting, WHAT after.
    Returns (why_proof_id, execute_fn) — call execute_fn only if why_proof_id is set.
    """
    # Step 1: Anchor WHY via check_coherence MCP tool (or REST equivalent)
    # MCP: { "name": "check_coherence", "arguments": { ... } }
    # REST fallback — hash the coherence payload and certify it:
    payload = {
        "type": "coherence_check", "role": "WHY",
        "intent": intent, "context": context, "decision": decision, "who": agent_id
    }
    coherence_anchor = hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode()
    ).hexdigest()

    why_resp = requests.post(f"{BASE}/api/proof",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={
            "file_hash": coherence_anchor,
            "filename": f"coherence-check-{agent_id}.json",
            "metadata": {**payload, "who": agent_id, "what": decision, "why": intent}
        }, timeout=10).json()

    why_proof_id = why_resp.get("proof_id")
    if not why_proof_id:
        raise RuntimeError("Coherence check failed — action blocked (no proof = no action)")

    return why_proof_id, coherence_anchor


# ── Usage ────────────────────────────────────────────────────────────────────

why_id, anchor = prove_before_act(
    intent="Optimize portfolio for Q3",
    context="BTC RSI=38, allocation 2.1%, vol 0.42",
    decision="BUY 0.5 BTC at market",
    agent_id="trading-agent-v2"
)

# Step 2: Execute (only reached if WHY is anchored)
result = execute_trade("BUY", "BTC", 0.5)

# Step 3: Anchor WHAT — link to the WHY proof
what_content = json.dumps({"result": result, "why_proof_id": why_id}, sort_keys=True)
what_hash = hashlib.sha256(what_content.encode()).hexdigest()
what_resp = requests.post(f"{BASE}/api/proof",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "file_hash": what_hash,
        "filename": "trade-result.json",
        "metadata": {
            "who": "trading-agent-v2", "what": "Executed BUY 0.5 BTC",
            "why_proof_id": why_id,  # ← links WHAT to WHY
            "role": "WHAT"
        }
    }, timeout=10).json()

print(f"WHY: https://xproof.app/proof/{why_id}")
print(f"WHAT: https://xproof.app/proof/{what_resp['proof_id']}")`}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ── 4W proof ─────────────────────────────────────────────────────── */}
        <section className="py-16 md:py-20">
          <div className="container">
            <div className="mx-auto max-w-4xl">
              <div className="mb-10 text-center">
                <Badge variant="outline" className="mb-4">4W Audit Trail</Badge>
                <h2 className="mb-3 text-2xl md:text-3xl font-bold">
                  Every question an auditor will ask, answered on-chain
                </h2>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  {
                    w: "WHO",
                    question: "Who is the agent?",
                    answer: "MX-8004 / SIGIL — identity layer, soulbound NFT, verifiable on MultiversX",
                    role: "Identity",
                    highlight: false,
                  },
                  {
                    w: "WHY",
                    question: "Why did it act?",
                    answer: "check_coherence — intent + context + decision anchored BEFORE execution",
                    role: "Coherence (new)",
                    highlight: true,
                  },
                  {
                    w: "WHAT",
                    question: "What did it produce?",
                    answer: "certify_file / xProof — output hash anchored AFTER execution",
                    role: "Proof of existence",
                    highlight: false,
                  },
                  {
                    w: "WHEN",
                    question: "When did each step happen?",
                    answer: "MultiversX block timestamp — immutable, publicly verifiable",
                    role: "Immutable timestamp",
                    highlight: false,
                  },
                ].map((item) => (
                  <div
                    key={item.w}
                    className={`rounded-md border p-5 ${
                      item.highlight ? "border-primary bg-primary/5" : "border-border/60 bg-muted/20"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className={`text-2xl font-bold ${item.highlight ? "text-primary" : "text-foreground"}`}>
                        {item.w}
                      </span>
                      <Badge variant={item.highlight ? "default" : "secondary"} className="text-xs">
                        {item.role}
                      </Badge>
                    </div>
                    <p className="text-sm font-medium mb-1">{item.question}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{item.answer}</p>
                  </div>
                ))}
              </div>

              <div className="mt-6 rounded-md border border-primary/20 bg-primary/5 p-5 flex items-start gap-4">
                <Network className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold mb-1">
                    The Coherence Layer fills the WHY gap
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    xProof already answered WHAT and WHEN. MX-8004 answers WHO. The Coherence Layer —
                    anchored via <code className="font-mono text-xs bg-muted px-1 rounded">check_coherence</code> —
                    closes the loop by answering WHY. All four W's are now on-chain, independently verifiable,
                    and reconstructible by any auditor.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── For organizations ─────────────────────────────────────────────── */}
        <section className="border-t bg-muted/20 py-16 md:py-20">
          <div className="container">
            <div className="mx-auto max-w-4xl">
              <div className="mb-10 text-center">
                <Badge variant="outline" className="mb-4">Infrastructure</Badge>
                <h2 className="mb-3 text-2xl md:text-3xl font-bold">
                  The trust layer for agentic organizations
                </h2>
                <p className="text-muted-foreground max-w-xl mx-auto">
                  As agent fleets grow, coherence becomes the question that matters most:
                  who guarantees the global alignment of the system?
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  {
                    title: "Transparent",
                    desc: "Every agent's WHY is public and on-chain. Any stakeholder can verify intent matches result without access to proprietary systems.",
                    icon: Eye,
                  },
                  {
                    title: "Accountable",
                    desc: "When an outcome diverges from the stated intent, the coherence anchor proves exactly what was decided and why — before the deviation occurred.",
                    icon: Shield,
                  },
                  {
                    title: "Auditable",
                    desc: "Full 4W history — WHO acted, WHY they decided, WHAT they produced, WHEN each step happened — reconstructible at any point in the future.",
                    icon: Blocks,
                  },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.title} className="rounded-md border border-border/60 bg-background p-5">
                      <Icon className="h-5 w-5 text-primary mb-3" />
                      <h3 className="text-sm font-semibold mb-2">{item.title}</h3>
                      <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                    </div>
                  );
                })}
              </div>

              <blockquote className="mt-10 border-l-2 border-primary pl-6 py-2">
                <p className="text-base text-muted-foreground leading-relaxed italic">
                  "An action without context is automation. An action with proof is verifiable.
                  An action with coherence is{" "}
                  <strong className="text-foreground not-italic">worthy of trust.</strong>"
                </p>
                <cite className="mt-2 block text-xs text-muted-foreground/60">
                  — xProof Coherence Layer Manifesto
                </cite>
              </blockquote>
            </div>
          </div>
        </section>

        {/* ── CTA ───────────────────────────────────────────────────────────── */}
        <section className="border-t py-16 md:py-20">
          <div className="container">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="mb-4 text-2xl md:text-3xl font-bold">
                Start anchoring your agent's reasoning today
              </h2>
              <p className="mb-8 text-muted-foreground">
                10 free proofs — no wallet, no credit card. Full Prove Before Act loop in under 2 minutes.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button asChild size="lg" className="text-base h-12 px-8">
                  <a href="/#free-trial">
                    <Bot className="mr-2 h-4 w-4" />
                    Get 10 free proofs
                  </a>
                </Button>
                <Button asChild variant="outline" size="lg" className="text-base h-12 px-8">
                  <a href="/agent-context">
                    Agent integration guide
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </div>
              <p className="mt-5 text-xs text-muted-foreground">
                Or explore the full spec at{" "}
                <a href="/.well-known/xproof.md" className="text-primary hover:underline font-mono">
                  /.well-known/xproof.md
                </a>
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
