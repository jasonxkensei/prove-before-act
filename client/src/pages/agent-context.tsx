import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";
import {
  Bot,
  Zap,
  AlertTriangle,
  DollarSign,
  BarChart3,
  Cpu,
  Shield,
  Eye,
  Network,
  Play,
  Copy,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ArrowRight,
  Clock,
  RefreshCw,
  Lock,
  TrendingUp,
  Star,
  Cog,
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
      data-testid="button-copy-code"
    >
      {copied ? <CheckCircle className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
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

type Section = {
  id: string;
  icon: React.ElementType;
  title: string;
  badge?: string;
  content: React.ReactNode;
};

export default function AgentContextPage() {
  const { data: pricing } = useQuery<{ current_price_usd: number }>({
    queryKey: ["/api/pricing"],
  });
  const unitPrice = pricing?.current_price_usd;
  const priceStr = unitPrice === undefined ? "loading…" : `$${unitPrice.toFixed(2)}`;
  const per1k = unitPrice === undefined ? "loading…" : `$${(unitPrice * 1000).toFixed(0)}`;
  const per10k = unitPrice === undefined ? "loading…" : `$${(unitPrice * 10000).toFixed(0)}`;
  const per30k = unitPrice === undefined ? "loading…" : `$${(unitPrice * 30000).toFixed(0)}`;
  const per30kPerAgent = unitPrice === undefined ? "loading…" : `$${(unitPrice * 600).toFixed(0)}`;

  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    production: true,
    x402: true,
    latency: true,
    retry: true,
    cost: true,
    comparison: true,
    mcp: true,
    "4w": true,
    privacy: true,
    fleet: true,
    workflow: true,
    coherence: true,
    moltbook: true,
    keyfields: true,
    integrations: true,
  });

  const toggle = (id: string) =>
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const [exampleLang, setExampleLang] = useState<"python" | "typescript">("python");

  const sections: Section[] = [
    {
      id: "production",
      icon: Cog,
      title: "How to run Prove Before Act in production? Batch, monitoring, and policies.",
      badge: "Production ready",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Four patterns every production deployment should have: batch anchoring, proof-count monitoring, a clear error policy, and a "no proof = no action" gate.
          </p>

          {/* Batch */}
          <div>
            <p className="text-xs font-semibold mb-2">1. Batch anchoring — up to 50 files per call</p>
            <p className="text-xs text-muted-foreground mb-2">
              Instead of one HTTP call per action, group up to 50 file hashes in a single <code className="font-mono bg-muted px-1 rounded">POST /api/batch</code>. Reduces overhead for high-volume fleets from 50× calls to 1 call.
            </p>
            <CodeBlock lang="python" code={`import hashlib, requests

# declared_decisions: list of strings — each is a declared decision basis (never raw prompts or chain-of-thought)
# The basis stays local: only its hash is sent. Metadata is classification-only
# (fixed role/action_type/opaque IDs) — never the basis text or anything derived from it.
actions = [
    {"file_hash": hashlib.sha256(d.encode()).hexdigest(),
     "filename": f"decision-{i}.json",
     "metadata": {"who": agent_id, "action_type": "decision", "decision_id": f"dec_{i}"}}
    for i, d in enumerate(declared_decisions)
]

# One call — up to 50 items
resp = requests.post(
    "https://provebeforeact.com/api/batch",
    headers={"Authorization": f"Bearer {api_key}"},
    json={"certifications": actions},
    timeout=30
).json()

# resp["results"] = [{"proof_id": "prf_...", "status": "pending"}, ...]
proof_ids = [r["proof_id"] for r in resp["results"]]`} />
          </div>

          {/* Monitoring */}
          <div>
            <p className="text-xs font-semibold mb-2">2. Monitoring — proofs anchored per day</p>
            <p className="text-xs text-muted-foreground mb-2">
              Use <code className="font-mono bg-muted px-1 rounded">GET /api/certifications?limit=1</code> headers to get your total count, or poll daily and alert if volume drops unexpectedly.
            </p>
            <CodeBlock lang="python" code={`import requests, datetime

def daily_proof_count(api_key: str) -> int:
    """Count proofs anchored today."""
    today = datetime.date.today().isoformat()
    resp = requests.get(
        "https://provebeforeact.com/api/certifications",
        headers={"Authorization": f"Bearer {api_key}"},
        params={"limit": 1},
    )
    return int(resp.headers.get("X-Total-Count", 0))

count = daily_proof_count(api_key)
if count < EXPECTED_DAILY_MIN:
    alert(f"Prove Before Act volume anomaly: {count} proofs today (expected ≥{EXPECTED_DAILY_MIN})")`} />
          </div>

          {/* No proof = no action */}
          <div>
            <p className="text-xs font-semibold mb-2">3. Policy gate — "no proof = no action"</p>
            <p className="text-xs text-muted-foreground mb-2">
              For high-stakes agents (trading, legal, medical), make the proof a hard prerequisite. The action <em>does not proceed</em> if anchoring fails.
            </p>
            <CodeBlock lang="python" code={`def prove_before_act(decision_basis: dict, action_fn, api_key: str):
    """Execute action only after proof of the declared decision basis is anchored."""
    proof = anchor_with_retry(
        file_hash=sha256(decision_basis),
        filename="decision_basis.json",
        api_key=api_key
    )
    if proof is None:
        raise PolicyError(
            "Proof anchoring failed after 3 retries. "
            "Operator policy paused this action — no proof = no action."
        )
    # Proof anchored — safe to proceed
    result = action_fn()
    return {"result": result, "proof_id": proof["proof_id"]}`} />
          </div>

          {/* Error handling */}
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-1">4. Error handling summary</p>
            <ul className="text-xs text-muted-foreground space-y-1 ml-2">
              <li>• <code className="font-mono bg-muted px-1 rounded">200</code> — proof anchored, proceed</li>
              <li>• <code className="font-mono bg-muted px-1 rounded">409</code> — already anchored, retrieve existing <code className="font-mono bg-muted px-1 rounded">proof_id</code></li>
              <li>• <code className="font-mono bg-muted px-1 rounded">429</code> — rate limited, wait <code className="font-mono bg-muted px-1 rounded">Retry-After</code> seconds</li>
              <li>• <code className="font-mono bg-muted px-1 rounded">5xx / timeout</code> — retry up to 3× with exponential backoff (1s → 2s → 4s)</li>
              <li>• After 3 failures: apply your operator policy — log locally and optionally block a high-stakes action, or proceed with a local log (best-effort)</li>
            </ul>
            <p className="text-xs text-muted-foreground mt-2">
              Full retry implementation: see the <strong className="text-foreground">retry policy</strong> section below.
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "x402",
      icon: Zap,
      title: "How does x402 work — payment without an API key?",
      badge: "Top differentiator",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            x402 is a payment-in-HTTP protocol. An agent sends a request with no credentials, receives an HTTP <code className="bg-muted px-1 rounded font-mono text-xs">402 Payment Required</code> response with the exact price and payment instructions, signs a USDC micro-payment on Base, then resends the original request with the signed payment header. No account, no API key, no pre-registration required.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { step: "1", title: "Send request", desc: "POST /api/proof without any auth header" },
              { step: "2", title: "Receive 402", desc: `Get current price (${priceStr} USDC) + payment payload to sign` },
              { step: "3", title: "Pay & anchor", desc: "Resend with X-PAYMENT header — get proof instantly" },
            ].map((s) => (
              <div key={s.step} className="rounded-md border bg-muted/30 p-3">
                <div className="text-xs font-bold text-primary mb-1">Step {s.step}</div>
                <div className="text-sm font-semibold mb-1">{s.title}</div>
                <div className="text-xs text-muted-foreground">{s.desc}</div>
              </div>
            ))}
          </div>
          <CodeBlock lang="bash" code={`# Step 1 — send without auth, receive 402 with price
curl -X POST https://provebeforeact.com/api/proof \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "YOUR_SHA256_HASH", "filename": "decision.md"}'
# → HTTP 402 {"payment": {"amount": "10000", "currency": "USDC", "network": "eip155:8453", ...}}

# Step 3 — resend with signed USDC payment on Base
curl -X POST https://provebeforeact.com/api/proof \\
  -H "Content-Type: application/json" \\
  -H "X-PAYMENT: <base64-signed-payment>" \\
  -d '{"file_hash": "YOUR_SHA256_HASH", "filename": "decision.md"}'
# → HTTP 200 {"proof_id": "...", "verify_url": "/proof/...", ...}`} />
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-1">Why this matters for agents</p>
            <p className="text-xs text-muted-foreground">
              A fully autonomous agent — with a wallet but no pre-established relationship with Prove Before Act — can anchor its first proof in a single session. No registration, no web UI, no human in the loop. The agent discovers the price, signs the payment, and gets the proof. Pure machine-to-machine.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">Complete Python x402 implementation (copy-paste ready):</p>
            <CodeBlock lang="python" code={`import hashlib, json, base64, requests

def anchor_x402(decision_doc: dict, filename: str, wallet_signer) -> dict:
    """
    Anchor a proof via x402 — no API key, no account needed.
    decision_doc: declared decision basis (NOT internal chain-of-thought, prompts, or step-by-step deliberation)
    wallet_signer: object with .sign_x402(payment_info) → signed_payment dict
    Compatible facilitators: Coinbase CDP, Conway Terminal, OpenClaw
    """
    # 1. Hash the declared decision basis locally — raw content never leaves this function
    content = json.dumps(decision_doc, sort_keys=True, ensure_ascii=False).encode()
    file_hash = hashlib.sha256(content).hexdigest()

    payload = {"file_hash": file_hash, "filename": filename}

    # 2. POST without auth → get HTTP 402 with price + payment payload
    r = requests.post("https://provebeforeact.com/api/proof", json=payload)
    assert r.status_code == 402, f"Expected 402, got {r.status_code}: {r.text}"

    payment_info = r.json()["payment"]
    # payment_info = {
    #   "amount": "10000", "currency": "USDC", "network": "eip155:8453",
    #   "payee": "0x...", "payload": { ... x402 standard payload ... }
    # }

    # 3. Sign with your Base wallet (USDC on eip155:8453)
    signed = wallet_signer.sign_x402(payment_info)
    x_payment = base64.b64encode(json.dumps(signed).encode()).decode()

    # 4. Resend with X-PAYMENT header → get proof_id immediately
    proof = requests.post("https://provebeforeact.com/api/proof",
        headers={"X-PAYMENT": x_payment},
        json=payload)
    assert proof.status_code == 200, proof.text

    data = proof.json()
    return {"proof_id": data["proof_id"], "verify_url": data["verify_url"]}


# Usage — no Prove Before Act account, no API key
result = anchor_x402(
    decision_doc={"decision": "BUY BTC", "rationale": "RSI=38", "ts": "2026-06-02T14:30:00Z"},
    filename="decision_001.json",
    wallet_signer=my_base_wallet   # your wallet adapter
)
print(f"Proof: https://provebeforeact.com{result['verify_url']}")`} />
          </div>
          <p className="text-xs text-muted-foreground">
            Compatible facilitators: <span className="font-mono">https://api.cdp.coinbase.com/platform/v2/x402</span> (Coinbase CDP), Conway Terminal, OpenClaw, any x402-enabled agent framework.
          </p>
        </div>
      ),
    },
    {
      id: "latency",
      icon: Clock,
      title: "What is the real anchoring latency?",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Use the <strong className="text-foreground">xproof_agent_verify</strong> legacy agent identifier as a reference and query its public profile for current measurements:
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "Single cert (API call → proof_id)", value: "~1–2s", detail: "typical; varies with load" },
              { label: "Batch of 3 files", value: "~2s", detail: "typical; varies with load" },
              { label: "On-chain confirmation", value: "~6s", detail: "MultiversX avg block time" },
            ].map((m) => (
              <div key={m.label} className="rounded-md border bg-muted/30 p-3 text-center">
                <div className="text-2xl font-bold text-primary mb-1">{m.value}</div>
                <div className="text-xs font-medium mb-1">{m.label}</div>
                <div className="text-xs text-muted-foreground">{m.detail}</div>
              </div>
            ))}
          </div>
          <div className="rounded-md border bg-muted/30 p-3 space-y-1">
            <p className="text-xs font-semibold">What "1.1 seconds" covers:</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 ml-3">
              <li>• Hash received and validated by the API</li>
              <li>• Entitlement checked (API key or x402 payment verified)</li>
              <li>• Proof record created in database</li>
              <li>• Blockchain transaction submitted to MultiversX queue</li>
              <li>• <code className="font-mono bg-muted px-1 rounded">proof_id</code> returned — your agent can continue immediately</li>
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong>Note:</strong> The <code className="font-mono bg-muted px-1 rounded text-xs">proof_id</code> is returned immediately (status: <code className="font-mono bg-muted px-1 rounded text-xs">pending</code>). On-chain confirmation happens asynchronously within ~6 seconds. Use the <code className="font-mono bg-muted px-1 rounded text-xs">webhook_url</code> field to receive a callback when the transaction is confirmed on-chain.
          </p>
        </div>
      ),
    },
    {
      id: "retry",
      icon: RefreshCw,
      title: "What to do if the Prove Before Act call fails? Retry policy & fallback.",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act is designed to fail gracefully. Here is the recommended policy for production agents:
          </p>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-semibold mb-2">HTTP status codes and what they mean</p>
              <div className="space-y-1.5 text-xs">
                {[
                  { code: "200", action: "Success. Proceed with action.", color: "text-primary" },
                  { code: "402", action: "Payment required (x402 flow). Sign USDC payment and retry.", color: "text-primary" },
                  { code: "409", action: "Duplicate hash already anchored — retrieve existing proof_id, no re-anchoring needed.", color: "text-blue-400" },
                  { code: "429", action: "Rate limited. Retry after Retry-After header value.", color: "text-amber-400" },
                  { code: "5xx", action: "Server error. Retry with exponential backoff.", color: "text-red-400" },
                  { code: "timeout", action: "Network issue. Retry up to 3x with backoff before falling back.", color: "text-red-400" },
                ].map((r) => (
                  <div key={r.code} className="flex items-start gap-2">
                    <code className={`font-mono font-bold w-14 shrink-0 ${r.color}`}>{r.code}</code>
                    <span className="text-muted-foreground">{r.action}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <CodeBlock lang="python" code={`import time, hashlib, requests

def anchor_with_retry(file_hash: str, filename: str, api_key: str, max_retries=3):
    """Production-grade anchor with retry + fallback."""
    backoff = [1, 2, 4]  # seconds between retries
    
    for attempt in range(max_retries):
        try:
            resp = requests.post(
                "https://provebeforeact.com/api/proof",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"file_hash": file_hash, "filename": filename},
                timeout=10
            )
            if resp.status_code == 200:
                return resp.json()["proof_id"]
            if resp.status_code == 409:
                return resp.json()["existing_proof_id"]  # already anchored
            if resp.status_code == 429:
                time.sleep(int(resp.headers.get("Retry-After", 5)))
                continue
            if resp.status_code >= 500:
                time.sleep(backoff[attempt])
                continue
        except requests.Timeout:
            time.sleep(backoff[attempt])
            continue
    
    # Fallback: log locally, continue without blocking the action
    log_local_fallback(file_hash, filename)
    return None  # action proceeds without proof_id`} />
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-1">Recommended fallback policy</p>
            <p className="text-xs text-muted-foreground">
              If Prove Before Act is unreachable after 3 retries: <strong className="text-foreground">log the hash locally</strong> with a timestamp, proceed with the action, and attempt to anchor retroactively when connectivity restores. Never block a critical agent action indefinitely on proof anchoring — but always log the attempt.
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "cost",
      icon: DollarSign,
      title: "What is the average cost per 1,000 anchors?",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act uses a flat rate of <strong className="text-foreground">{priceStr} per certification</strong>. <strong className="text-foreground">This is the live rate from <code className="font-mono bg-muted px-1 rounded">/api/pricing</code>, not a fixed published price.</strong> There are no tiers or volume discounts; the same live rate applies whether you anchor 1 or 10,000 proofs.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "Current price", value: priceStr, detail: "per certification — live rate" },
              { label: "Cost per 1,000 anchors", value: per1k, detail: `at ${priceStr} per cert` },
              { label: "Cost per 10,000 anchors", value: per10k, detail: "same flat rate" },
            ].map((m) => (
              <div key={m.label} className="rounded-md border bg-muted/30 p-3 text-center">
                <div className="text-2xl font-bold text-primary mb-1">{m.value}</div>
                <div className="text-xs font-medium mb-1">{m.label}</div>
                <div className="text-xs text-muted-foreground">{m.detail}</div>
              </div>
            ))}
          </div>
          <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
            <p className="text-xs font-semibold">Cost comparison for a fleet of 50 agents, 20 actions/day each:</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 ml-3">
              <li>• 50 agents × 20 actions × 30 days = <strong className="text-foreground">30,000 anchors/month</strong></li>
              <li>• At {priceStr}/anchor = <strong className="text-foreground">{per30k}/month</strong></li>
              <li>• Per agent: <strong className="text-foreground">{per30kPerAgent}/month</strong> — lower than most SaaS compliance tools</li>
              <li>• Batch mode (up to 50 files per call): same price, reduced API overhead</li>
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong>Payment methods:</strong> EGLD on MultiversX (via ACP/wallet), USDC on Base (via x402 — no account needed), or prepaid packs through Stripe Checkout or USDC/Base. Stripe is an additional option available from the dashboard.
          </p>
        </div>
      ),
    },
    {
      id: "comparison",
      icon: BarChart3,
      title: "How does Prove Before Act compare to Arweave, Ceramic, Sign Protocol?",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground text-xs">
            Honest matrix — each tool wins on its own terrain. Use this to choose the right tool for the right job.
          </p>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-2 font-semibold text-muted-foreground">Use case</th>
                  <th className="text-center py-2 px-2 font-semibold text-primary">Prove Before Act</th>
                  <th className="text-center py-2 px-2 font-semibold text-muted-foreground">Arweave</th>
                  <th className="text-center py-2 px-2 font-semibold text-muted-foreground">Ceramic</th>
                  <th className="text-center py-2 px-2 font-semibold text-muted-foreground">Sign Protocol</th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    useCase: "Anchor agent decision before execution (WHY before WHAT)",
                    "Prove Before Act": "✓ Native",
                    arweave: "Possible (heavy)",
                    ceramic: "Possible",
                    sign: "Partial",
                  },
                  {
                    useCase: "Pay per proof with no API key (x402 / USDC)",
                    "Prove Before Act": "✓ Native",
                    arweave: "✗",
                    ceramic: "✗",
                    sign: "✗",
                  },
                  {
                    useCase: "4W audit trail (Who, What, When, Why) rendered on public page",
                    "Prove Before Act": "✓ Native",
                    arweave: "✗",
                    ceramic: "Partial",
                    sign: "Partial",
                  },
                  {
                    useCase: "Privacy by default (hash only, file never uploaded)",
                    "Prove Before Act": "✓ Default",
                    arweave: "Uploads file",
                    ceramic: "Configurable",
                    sign: "Configurable",
                  },
                  {
                    useCase: "Store full file permanently on-chain",
                    "Prove Before Act": "✗",
                    arweave: "✓ Best tool",
                    ceramic: "Partial",
                    sign: "✗",
                  },
                  {
                    useCase: "MCP tool (JSON-RPC 2.0, agent-native integration)",
                    "Prove Before Act": "✓ Native",
                    arweave: "✗",
                    ceramic: "✗",
                    sign: "✗",
                  },
                  {
                    useCase: "Agent trust leaderboard + public profile",
                    "Prove Before Act": "✓ Native",
                    arweave: "✗",
                    ceramic: "✗",
                    sign: "✗",
                  },
                  {
                    useCase: "EVM / Ethereum attestation schemas",
                    "Prove Before Act": "✗",
                    arweave: "✗",
                    ceramic: "Partial",
                    sign: "✓ Best tool",
                  },
                  {
                    useCase: "Confidence-level staged anchoring (pre-commitment)",
                    "Prove Before Act": "✓ Native",
                    arweave: "✗",
                    ceramic: "✗",
                    sign: "✗",
                  },
                  {
                    useCase: "Cost per 1,000 anchors",
                    "Prove Before Act": per1k,
                    arweave: "~$5–50 (file size dep.)",
                    ceramic: "Node required †",
                    sign: "~$20–100 (gas)",
                  },
                ].map((row, i) => (
                  <tr key={i} className={`border-b border-border/40 ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
                    <td className="py-2 px-2 text-muted-foreground max-w-[160px]">{row.useCase}</td>
                    <td className={`py-2 px-2 text-center font-medium ${row["Prove Before Act"].startsWith("✓") ? "text-primary" : "text-muted-foreground"}`}>{row["Prove Before Act"]}</td>
                    <td className={`py-2 px-2 text-center ${row.arweave.startsWith("✓") ? "text-primary" : "text-muted-foreground"}`}>{row.arweave}</td>
                    <td className={`py-2 px-2 text-center ${row.ceramic.startsWith("✓") ? "text-primary" : "text-muted-foreground"}`}>{row.ceramic}</td>
                    <td className={`py-2 px-2 text-center ${row.sign.startsWith("✓") ? "text-primary" : "text-muted-foreground"}`}>{row.sign}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground italic">
            Rule of thumb: use <strong className="text-foreground">Arweave</strong> to store files forever. Use <strong className="text-foreground">Sign Protocol</strong> for EVM attestation schemas. Use <strong className="text-foreground">Prove Before Act</strong> when an agent needs to prove a decision before acting — especially with no pre-existing account.
          </p>
          <p className="text-xs text-muted-foreground/60">
            † Ceramic Network mainnet was deprecated in 2024. Current usage requires a self-hosted node or a third-party provider. "Free" understates the operational cost.
          </p>
        </div>
      ),
    },
    {
      id: "mcp",
      icon: Cpu,
      title: "How to integrate Prove Before Act via MCP? Concrete examples.",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act exposes a native MCP server at <code className="font-mono bg-muted px-1 rounded text-xs">https://provebeforeact.com/mcp</code>. Use Streamable HTTP transport (POST). Core tools include <code className="font-mono bg-muted px-1 rounded text-xs">register_trial</code>, <code className="font-mono bg-muted px-1 rounded text-xs">certify_file</code>, <code className="font-mono bg-muted px-1 rounded text-xs">verify_proof</code>, <code className="font-mono bg-muted px-1 rounded text-xs">audit_agent_session</code>, and <code className="font-mono bg-muted px-1 rounded text-xs">investigate_proof</code>. Call <code className="font-mono bg-muted px-1 rounded text-xs">tools/list</code> for the complete current catalog; this list is not exhaustive.
          </p>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 flex items-start gap-3">
            <Cpu className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-primary mb-1">OpenClaw / ClawHub installation</p>
              <p className="text-xs text-muted-foreground mb-2">
                Prove Before Act is published on ClawHub. Install the verified OpenClaw skill in one command:
              </p>
              <code className="text-xs bg-muted px-2 py-1 rounded block font-mono">openclaw skills install @jasonxkensei/xproof</code>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">1. Add to your MCP config (Claude, Cursor, any MCP client):</p>
            <CodeBlock lang="json" code={`{
  "mcpServers": {
    "prove-before-act": {
      "url": "https://provebeforeact.com/mcp",
      "headers": {
        "Authorization": "Bearer pm_YOUR_API_KEY"
      }
    }
  }
}`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">2. Use <code className="font-mono bg-muted px-1 rounded">certify_file</code> — anchor a decision before acting:</p>
            <CodeBlock lang="json" code={`// MCP tool call: certify_file
// The declared decision basis is hashed locally; only file_hash + classification-only
// metadata are sent. No basis text, rationale/why, or outcome details in metadata.
{
  "name": "certify_file",
  "arguments": {
    "file_hash": "sha256_of_your_declared_decision_basis",
    "filename": "decision_2026-06-02.md",
    "author": "my-agent-v2",
    "metadata": {
      "who": "my-agent-v2",
      "action_type": "trade_execution",
      "category": "finance",
      "when": "2026-06-02T14:30:00Z",
      "model": "gpt-4o",
      "session_id": "sess_abc123",
      "decision_id": "dec_abc123"
    }
  }
}
// Response: { proof_id: "...", verify_url: "/proof/...", status: "pending" }`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">3. Use <code className="font-mono bg-muted px-1 rounded">audit_agent_session</code> — compliance gate before critical action:</p>
            <CodeBlock lang="json" code={`// Inputs and basis stay local — only their hash + classification-only fields are sent.
// No input field names, sources, or decision content in the request.
{
  "name": "audit_agent_session",
  "arguments": {
    "agent_id": "trading-agent-v2",
    "session_id": "sess_abc123",
    "action_type": "trade_execution",
    "inputs_hash": "sha256_of_all_inputs_analyzed",
    "risk_level": "high",
    "decision_id": "dec_abc123"
  }
}
// COMPLIANCE GATE: action only proceeds if proof_id is returned`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">4. For agents without an API key yet — use <code className="font-mono bg-muted px-1 rounded">register_trial</code>:</p>
            <CodeBlock lang="json" code={`{
  "name": "register_trial",
  "arguments": {
    "agent_name": "my-new-agent"
  }
}
// Returns: { api_key: "pm_...", free_certifications: 10 }
// Use that api_key immediately for the next 10 proofs — no browser, no wallet`} />
          </div>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-2">5. Zero-account bootstrap: MCP trial key → x402 for production</p>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p><strong className="text-foreground">Step A</strong> — Bootstrap via MCP (no account, no wallet):</p>
              <CodeBlock lang="json" code={`// Call register_trial to get 10 free proofs instantly
{ "name": "register_trial", "arguments": { "agent_name": "my-agent" } }
// → { "api_key": "pm_...", "free_certifications": 10 }`} />
              <p><strong className="text-foreground">Step B</strong> — Scale up via x402 (no account, just a Base wallet):</p>
              <CodeBlock lang="bash" code={`# After 10 free proofs, switch to x402 for unlimited paid anchoring
# 1. POST /api/proof without auth → get HTTP 402 with price
# 2. Sign USDC on Base (eip155:8453) → resend with X-PAYMENT header
# → proof_id returned immediately, no Prove Before Act account ever needed`} />
              <p className="text-muted-foreground/70 italic">An agent can go from zero to production-grade proof anchoring in a single session: trial key via MCP for the first 10 proofs, then x402 for all subsequent proofs. No human ever touches the account.</p>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "4w",
      icon: Eye,
      title: "How does the 4W audit trail work?",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            The 4W audit trail is a structured accountability record anchored on-chain with every certification. It answers the four questions every auditor or regulator needs:
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { w: "WHO", desc: "Which agent, model, or actor made this decision", example: "my-agent-v2 (GPT-4o, session: sess_abc)" },
              { w: "WHAT", desc: "What action or output was certified", example: "Approved trade: BUY 0.5 BTC at $67,400" },
              { w: "WHEN", desc: "Immutable on-chain timestamp from MultiversX block", example: "2026-06-02T14:30:12Z (block #15,447,203)" },
              { w: "WHY", desc: "The declared decision basis — not internal chain-of-thought", example: "RSI below 40, allocation below target, risk approved by policy v3.1" },
            ].map((item) => (
              <div key={item.w} className="rounded-md border bg-muted/30 p-3">
                <div className="text-base font-bold text-primary mb-1">{item.w}</div>
                <div className="text-xs text-muted-foreground mb-1.5">{item.desc}</div>
                <div className="text-xs bg-muted rounded px-2 py-1 font-mono text-foreground/80">{item.example}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Public metadata is optional and classification-only: use intentionally public identifiers such as <code className="font-mono bg-muted px-1 rounded text-xs">who</code>, <code className="font-mono bg-muted px-1 rounded text-xs">when</code>, <code className="font-mono bg-muted px-1 rounded text-xs">action_type</code>, or an opaque <code className="font-mono bg-muted px-1 rounded text-xs">decision_id</code>. Keep the WHY document and its rationale local; never place them in <code className="font-mono bg-muted px-1 rounded text-xs">metadata</code>. The public trail is rendered at <code className="font-mono bg-muted px-1 rounded text-xs">/proof/&#123;id&#125;</code>.
          </p>
          <CodeBlock lang="bash" code={`# The declared decision basis is hashed locally — the basis text, rationale, and
# inputs stay on your machine. Only file_hash + classification-only metadata are sent.
curl -X POST https://provebeforeact.com/api/proof \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "file_hash": "YOUR_SHA256",
    "filename": "decision_basis_session_001.md",
    "metadata": {
      "who": "trading-agent-v2",
      "action_type": "trade_execution",
      "category": "finance",
      "when": "2026-06-02T14:30:00Z",
      "model": "gpt-4o-mini",
      "session_id": "sess_abc123",
      "decision_id": "dec_abc123"
    }
  }'`} />
        </div>
      ),
    },
    {
      id: "privacy",
      icon: Lock,
      title: "Privacy risks — what is sent, what stays local?",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act is built on a <strong className="text-foreground">hash-only model</strong>: your file, declared decision basis, or agent output never leaves your environment. Only its SHA-256 fingerprint is transmitted.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
              <p className="text-xs font-semibold text-primary mb-2">What is sent to Prove Before Act</p>
              <ul className="text-xs text-muted-foreground space-y-1 ml-2">
                <li>• SHA-256 hash (64 hex characters)</li>
                <li>• Filename (can be synthetic)</li>
                <li>• Optional 4W metadata fields (you control what you share)</li>
                <li>• Author field (optional)</li>
              </ul>
            </div>
            <div className="rounded-md border border-muted bg-muted/30 p-3">
              <p className="text-xs font-semibold mb-2">What stays entirely local</p>
              <ul className="text-xs text-muted-foreground space-y-1 ml-2">
                <li>• The actual file content</li>
                <li>• Declared decision-basis document text</li>
                <li>• Input data values</li>
                <li>• Model weights or strategy details</li>
              </ul>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold">Known privacy considerations:</p>
            <div className="space-y-1.5 text-xs text-muted-foreground ml-2">
              <p><strong className="text-foreground">Timing correlation:</strong> Frequent anchor patterns can reveal agent activity rhythm. Mitigate by batching with <code className="font-mono bg-muted px-1 rounded text-xs">POST /api/batch</code> or adding jitter.</p>
              <p><strong className="text-foreground">Metadata exposure:</strong> Every metadata field is stored and rendered publicly if <code className="font-mono bg-muted px-1 rounded text-xs">is_public: true</code>. Send only intentionally public classifications and opaque IDs—never a declared decision basis, its rationale, prompts, or input data.</p>
              <p><strong className="text-foreground">On-chain permanence:</strong> Once a transaction is confirmed on MultiversX, it cannot be deleted. Design your metadata accordingly.</p>
              <p><strong className="text-foreground">Not a ZK system:</strong> Prove Before Act uses SHA-256 hashing, not zero-knowledge proofs. A determined adversary with access to the original data can verify the hash matches. If ZK is required, combine with a ZK proving layer upstream.</p>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "fleet",
      icon: Network,
      title: "Can you monitor proofs from a fleet of agents? How?",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Yes. Prove Before Act is designed for multi-agent fleets. Each agent gets its own wallet address and public profile. A supervisor can monitor all agents centrally.
          </p>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold">Per-agent monitoring endpoints (all public, no auth):</p>
              <div className="space-y-1.5 text-xs font-mono text-muted-foreground">
                <p><span className="text-primary">GET</span> /api/agents/&#123;wallet&#125; — trust score, total certs, streak, violations</p>
                <p><span className="text-primary">GET</span> /api/agents/&#123;wallet&#125;/timeline — full audit timeline (paginated)</p>
                <p><span className="text-primary">GET</span> /api/trust/&#123;wallet&#125; — lightweight trust lookup</p>
                <p><span className="text-primary">GET</span> /api/leaderboard — top 50 public agents by trust score</p>
                <p><span className="text-primary">GET</span> /badge/trust/&#123;wallet&#125;.svg — embeddable trust badge</p>
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-semibold mb-2">Recommended fleet architecture:</p>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                <p>1. Each agent has its own <code className="font-mono bg-muted px-1 rounded">pm_</code> API key tied to its MultiversX wallet</p>
                <p>2. Each agent anchors decisions with its own identity (<code className="font-mono bg-muted px-1 rounded">who</code> field = agent ID)</p>
                <p>3. Supervisor polls <code className="font-mono bg-muted px-1 rounded">/api/agents/&#123;wallet&#125;</code> for each agent hourly</p>
                <p>4. Alert when: trust score drops, violation count increases, streak breaks, no anchor in 24h</p>
                <p>5. Use <code className="font-mono bg-muted px-1 rounded">webhook_url</code> for real-time callbacks on each anchored proof</p>
              </div>
            </div>
          </div>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-1">Reference agent profile</p>
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">xproof_agent_verify</strong> is a legacy agent identifier. Query its public profile at <code className="font-mono bg-muted px-1 rounded text-xs">/agent/erd1hlx4xann...gyu9</code> for current proof counts, streaks, and confirmation status.
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "workflow",
      icon: Play,
      title: "Complete agent workflow: decision basis → hash → anchor → action",
      badge: "Copy-paste ready",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            This is the canonical <strong className="text-foreground">Prove Before Act</strong> loop. Copy this pattern into any agent framework.
          </p>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {["1. Reason (WHY)", "→", "2. Hash locally", "→", "3. Anchor on-chain", "→", "4. Get proof_id", "→", "5. Execute (WHAT)"].map((s, i) => (
              <span key={i} className={s === "→" ? "text-muted-foreground/40" : "rounded bg-primary/10 text-primary px-2 py-1 font-medium"}>{s}</span>
            ))}
          </div>
          <CodeBlock lang="python" code={`import hashlib, json, requests

class ProveBeforeAct:
    """
    Core Prove Before Act loop for autonomous agents.
    Anchor a declared decision basis BEFORE executing any significant action.

    INVARIANT: Only declared decision bases (summaries of WHY the agent is acting,
    key inputs, and the chosen action) should be anchored. Never send or include
    private chain-of-thought, hidden reasoning steps, raw prompts, or any
    step-by-step deliberation in the content you hash or in metadata fields.
    """
    
    def __init__(self, api_key: str, agent_id: str):
        self.api_key = api_key
        self.agent_id = agent_id
        self.base = "https://provebeforeact.com"
    
    def anchor(self, decision_basis: dict, action_description: str) -> str | None:
        """
        Step 1-3: Hash the declared decision basis, anchor it, return proof_id.
        Call this BEFORE executing any action.
        decision_basis: declared decision basis — NOT chain-of-thought or raw prompts.
        """
        # Step 1: Serialize the declared decision basis canonically
        basis_json = json.dumps(decision_basis, sort_keys=True, ensure_ascii=False)
        
        # Step 2: Hash locally — raw content never leaves this function
        file_hash = hashlib.sha256(basis_json.encode()).hexdigest()
        
        # Step 3: Anchor to Prove Before Act
        try:
            resp = requests.post(
                f"{self.base}/api/proof",
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "file_hash": file_hash,
                    "filename": f"decision_basis_{decision_basis.get('session_id', 'unknown')}.json",
                    # Metadata is classification-only: fixed role/action_type and opaque IDs.
                    # Never send the basis object, its rationale/why, inputs, or anything derived from it.
                    "metadata": {
                        "who": self.agent_id,
                        "action_type": decision_basis.get("action_type", "decision"),
                        "when": decision_basis.get("timestamp"),
                        "model": decision_basis.get("model"),
                        "session_id": decision_basis.get("session_id"),
                        "decision_id": decision_basis.get("decision_id"),
                    }
                },
                timeout=10
            )
            if resp.status_code == 200:
                data = resp.json()
                return data["proof_id"]
        except Exception as e:
            self._log_fallback(file_hash, action_description, str(e))
        return None
    
    def run_with_proof(self, decision_basis: dict, action_fn, action_description: str):
        """
        Full Prove Before Act cycle.
        Action only runs after proof_id is obtained.
        decision_basis: declared decision basis — NOT chain-of-thought or raw prompts.
        """
        proof_id = self.anchor(decision_basis, action_description)
        
        if proof_id is None:
            # Soft failure: log and continue (or raise if policy requires hard stop)
            print(f"[WARN] No proof obtained for: {action_description}")
        
        # Execute the action — proof_id is available as audit reference
        result = action_fn()
        
        return {"result": result, "proof_id": proof_id, "verify_url": f"{self.base}/proof/{proof_id}"}
    
    def _log_fallback(self, file_hash, action, error):
        # Write to local audit log for later retroactive anchoring
        pass


# Usage example
agent = ProveBeforeAct(api_key="pm_YOUR_KEY", agent_id="my-agent-v2")

# Declared decision basis: key inputs + rationale + chosen action — NOT step-by-step deliberation.
# rationale + inputs are hashed locally and NEVER sent; only the classification-only
# fields (action_type, decision_id, session_id, model) travel in metadata above.
decision_basis = {
    "session_id": "sess_001",
    "decision_id": "dec_001",
    "action_type": "trade_execution",
    "timestamp": "2026-06-02T14:30:00Z",
    "model": "gpt-4o-mini",
    "rationale": "BTC RSI=38 (below 40 threshold), portfolio allocation=2.1% (below 3% cap). Risk policy v3.1 approves. Confidence: HIGH.",
    "inputs": {"btc_price": 67400, "rsi_14d": 38, "nav_pct": 2.1},
}

outcome = agent.run_with_proof(
    decision_basis=decision_basis,
    action_fn=lambda: execute_trade("BUY", "BTC", 0.5),
    action_description="Execute BUY 0.5 BTC at market price"
)
print(f"Trade executed. Proof: https://provebeforeact.com{outcome['verify_url']}")`} />
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-1">What this gives you</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 ml-2">
              <li>• Every action has a cryptographic proof of the declared decision basis that preceded it</li>
              <li>• The proof is publicly verifiable at <code className="font-mono bg-muted px-1 rounded">provebeforeact.com/proof/&#123;id&#125;</code> — no Prove Before Act account needed to verify</li>
              <li>• 4W audit trail is automatically rendered on the proof page</li>
              <li>• If the agent is compromised or behaves unexpectedly, you have a full forensic record</li>
            </ul>
          </div>
        </div>
      ),
    },
    {
      id: "coherence",
      icon: Play,
        title: "Coherence Layer — anchor your decision basis before acting",
      badge: "New",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            The <strong className="text-foreground">Coherence Layer</strong> closes the 4W loop.
            Prove Before Act already answers WHAT (certify_file) and WHEN (block timestamp). MX-8004 can answer WHO when its integration is active; production currently reports <code className="font-mono text-xs bg-muted px-1 rounded">not_configured</code>.{" "}
            <code className="font-mono text-xs bg-muted px-1 rounded">check_coherence</code> answers WHY —
            anchoring your agent's intent, context, and decision on-chain <em>before</em> acting.
          </p>

          {/* Full 4W loop */}
          <div className="grid gap-2 sm:grid-cols-4 text-xs">
            {[
              { w: "WHO", tool: "MX-8004 (optional)", when: "When active", role: "Identity", dim: true },
              { w: "WHY", tool: "check_coherence", when: "Before act", role: "Coherence", dim: false },
              { w: "WHAT", tool: "certify_file", when: "After act", role: "Proof", dim: true },
              { w: "WHEN", tool: "MultiversX block", when: "Automatic", role: "Timestamp", dim: true },
            ].map((item) => (
              <div key={item.w} className={`rounded-md border p-3 ${item.dim ? "bg-muted/20 border-border/50" : "bg-primary/5 border-primary/30"}`}>
                <div className={`text-lg font-bold mb-1 ${item.dim ? "text-foreground" : "text-primary"}`}>{item.w}</div>
                <div className="font-mono text-[10px] text-muted-foreground mb-0.5">{item.tool}</div>
                <div className="text-muted-foreground/70">{item.when}</div>
                <div className={`text-[10px] font-medium mt-1 ${item.dim ? "" : "text-primary"}`}>{item.role}</div>
              </div>
            ))}
          </div>

          {/* check_coherence step by step */}
          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            {["1. Write intent+context+decision", "→", "2. call check_coherence", "→", "3. get proof_id (WHY)", "→", "4. execute", "→", "5. certify_file (WHAT) + why_proof_id", "→", "6. POST /api/coherence/link"].map((s, i) => (
              <span key={i} className={s === "→" ? "text-muted-foreground/40" : "rounded bg-primary/10 text-primary px-2 py-1 font-medium"}>{s}</span>
            ))}
          </div>

          {/* Code examples */}
          <CodeBlock lang="python" code={`import hashlib, json, requests

API_KEY = "pm_YOUR_KEY"
BASE = "https://provebeforeact.com"

# ── Step 1: Anchor WHY via check_coherence MCP tool ──────────────────────────
# MCP call: { "name": "check_coherence", "arguments": { ... } }
# REST equivalent — hash the declared basis and certify with coherence metadata.
# INVARIANT: Use declared decision basis only — never include private chain-of-thought,
# hidden reasoning steps, raw prompts, or step-by-step deliberation here.
declared_basis = {
    "type": "coherence_check",
    "role": "WHY",
    "intent": "Optimize portfolio allocation for Q3",
    "context": "BTC RSI=38, allocation 2.1% (below 3% cap), vol_30d=0.42, policy v3.1 approved",
    "decision": "BUY 0.5 BTC at market — increases allocation to 2.8%",
    "who": "trading-agent-v2",
}
anchor = hashlib.sha256(
    json.dumps(declared_basis, sort_keys=True).encode()
).hexdigest()

# The basis (intent/context/decision) stays local — only its hash is sent.
# Metadata is classification-only: fixed role + opaque IDs. Never spread the basis
# object or send its intent, context, decision, or any derived text.
why_resp = requests.post(f"{BASE}/api/proof",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "file_hash": anchor,
        "filename": "coherence-check.json",
        "metadata": {
            "who": declared_basis["who"],
            "role": "WHY",
            "action_type": "coherence_check",
            "category": "finance",
            "decision_id": "dec_coh_abc123",
        }
    }).json()

why_proof_id = why_resp["proof_id"]
# → prf_coherence_abc123 — immutable WHY is now on-chain

# ── Step 2: Execute (action proceeds because WHY is anchored) ─────────────────
result = execute_trade("BUY", "BTC", 0.5)

# ── Step 3: Anchor WHAT — link back to WHY ────────────────────────────────────
what_hash = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
# The result stays local — only its hash is sent. Metadata is classification-only;
# the WHAT content is never disclosed, only the opaque why_proof_id link.
what_resp = requests.post(f"{BASE}/api/proof",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "file_hash": what_hash,
        "filename": "trade-result.json",
        "metadata": {
            "who": "trading-agent-v2",
            "role": "WHAT",
            "action_type": "trade_execution",
            "why_proof_id": why_proof_id,   # ← opaque link from WHAT to WHY
        }
    }).json()

# ── Step 4: Close the loop — POST /api/coherence/link ─────────────────────────
# Without this call the WHY anchor stays unlinked: it shows as "divergent"
# in your public coherence history after 1h, and after the 2h TTL it is also
# flagged as a proposed fault violation — both hurt your coherence rate.
link_resp = requests.post(f"{BASE}/api/coherence/link",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={"why_proof_id": why_proof_id, "what_proof_id": what_resp["proof_id"]})

if link_resp.status_code == 200:
    data = link_resp.json()
    print(f"Coherence score: {data['coherence_check']['coherence_score']}/100")
elif link_resp.status_code == 409:
    # ALREADY_LINKED — this WHY anchor is linked to a different WHAT.
    # (Re-linking the SAME pair returns 200 with already_linked=true.)
    print("Anchor already linked:", link_resp.json()["message"])
elif link_resp.status_code == 400:
    # NOT_A_COHERENCE_ANCHOR — why_proof_id is a regular proof, not a WHY
    # anchor. Create the WHY via check_coherence (or metadata.type =
    # "coherence_check") before linking.
    print("Link rejected:", link_resp.json()["error"])

print(f"WHY: {BASE}/proof/{why_proof_id}")
print(f"WHAT: {BASE}/proof/{what_resp['proof_id']}")`} />

          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold mb-1.5">Full loop on-chain</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 ml-2">
              <li>• WHY proof: intent + context + decision, anchored before action — auditors can reconstruct the exact state at decision time</li>
              <li>• WHAT proof: result hash linked to WHY via <code className="font-mono bg-muted px-1 rounded">why_proof_id</code> — any deviation from intent is permanently visible</li>
              <li>• Link call: <code className="font-mono bg-muted px-1 rounded">POST /api/coherence/link</code> records the WHY→WHAT pair and computes a coherence score (0–100). Unlinked anchors show as <strong className="text-foreground">divergent</strong> in public history after 1h; after the 2h TTL they are also flagged as proposed fault violations</li>
              <li>• Error cases: <code className="font-mono bg-muted px-1 rounded">409 ALREADY_LINKED</code> (anchor linked to a different WHAT), <code className="font-mono bg-muted px-1 rounded">400 NOT_A_COHERENCE_ANCHOR</code> (WHY was not created as a coherence anchor)</li>
              <li>• Public history: <code className="font-mono bg-muted px-1 rounded">GET /api/agents/&#123;wallet&#125;/coherence</code> — per-anchor status (linked / pending / divergent) + aggregate coherence rate</li>
              <li>• Both proofs are public, independently verifiable at <code className="font-mono bg-muted px-1 rounded">provebeforeact.com/proof/&#123;id&#125;</code></li>
            </ul>
          </div>

          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm" data-testid="button-coherence-page">
              <a href="/coherence">
                <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
                Coherence Layer docs
              </a>
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: "moltbook",
      icon: TrendingUp,
      title: "Moltbook case study — real production agent in operation",
      badge: "Live data",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            <strong className="text-foreground">xproof_agent_verify</strong> is the autonomous verification agent operated by <a href="https://www.moltbook.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">Moltbook</a> — a platform that certifies AI-generated content before publication. It has been running on Prove Before Act continuously since early 2026, making it one of the first documented production deployments of Prove Before Act in the wild.
          </p>

          {/* Key stats grid */}
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { value: "Live", label: "Proof count", detail: "Query the public profile" },
              { value: "Live", label: "Anchoring activity", detail: "Derived from current proof records" },
              { value: "Live", label: "Confirmation status", detail: "Check each proof response" },
            ].map((s) => (
              <div key={s.label} className="rounded-md border bg-muted/30 p-3 text-center">
                <div className="text-2xl font-bold text-primary mb-1">{s.value}</div>
                <div className="text-xs font-medium mb-0.5">{s.label}</div>
                <div className="text-xs text-muted-foreground">{s.detail}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold">Trust profile (public, real-time)</p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between"><span>Trust score</span><span className="font-mono text-foreground">Live value</span></div>
                <div className="flex justify-between"><span>Trust level</span><span className="font-mono text-foreground">Live value</span></div>
                <div className="flex justify-between"><span>Active streak</span><span className="font-mono text-foreground">Live value</span></div>
                <div className="flex justify-between"><span>Violations</span><span className="font-mono text-foreground">Live value</span></div>
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold">Performance benchmarks</p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between"><span>Single cert latency</span><span className="font-mono text-foreground">~1–2s typical</span></div>
                <div className="flex justify-between"><span>Batch of 3 files</span><span className="font-mono text-foreground">~2s typical</span></div>
                <div className="flex justify-between"><span>On-chain confirmation</span><span className="font-mono text-foreground">~6s</span></div>
                <div className="flex justify-between"><span>Cost per proof</span><span className="font-mono text-foreground">{priceStr} USDC (live)</span></div>
              </div>
            </div>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-semibold">What the agent anchors</p>
            <p className="text-xs text-muted-foreground">Before each piece of AI-generated content is published on Moltbook, <code className="font-mono bg-muted px-1 rounded">xproof_agent_verify</code> hashes the full content + generation metadata (model, prompt hash, timestamp), anchors the SHA-256 fingerprint on MultiversX, and attaches the <code className="font-mono bg-muted px-1 rounded">proof_id</code> to the published post. Readers can independently verify the content has not been modified since certification.</p>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-semibold">Operational cost</p>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>Use the live pricing endpoint and public proof count to estimate total cost.</p>
              <p>Estimate costs from the current price and the number of confirmed proof records you retrieve.</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm" data-testid="button-moltbook-profile">
              <a href="/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9" target="_blank" rel="noopener noreferrer">
                <Star className="mr-1.5 h-3.5 w-3.5" />
                View live agent profile
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="button-moltbook-review">
              <a href="https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Full Moltbook review
              </a>
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: "keyfields",
      icon: Shield,
      title: "Key metadata fields — what can be anchored with each proof",
      badge: "Reference",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Every proof accepts an optional <code className="bg-muted px-1 rounded font-mono text-xs">metadata</code> object. These fields are stored on-chain and rendered publicly on the proof page. Only include what you want public.
          </p>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-2 font-semibold text-muted-foreground">Field</th>
                  <th className="text-left py-2 px-2 font-semibold text-muted-foreground">Type</th>
                  <th className="text-left py-2 px-2 font-semibold text-muted-foreground">Description</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { field: "who", type: "string", desc: "Agent identifier, model name, or wallet address" },
                  { field: "what", type: "string", desc: "Action or output being certified" },
                  { field: "why", type: "string", desc: "Declared decision basis for the action (Prove Before Act anchor; not internal chain-of-thought)" },
                  { field: "confidence_score", type: "0.0–1.0", desc: "Model's self-reported certainty — surfaces on proof page" },
                  { field: "reversibility_class", type: "enum", desc: "'reversible' / 'costly' / 'irreversible' — risk classification for audit gates" },
                  { field: "model_hash", type: "sha256", desc: "Hash of model weights — detects identity drift between anchors" },
                  { field: "strategy_hash", type: "sha256", desc: "Hash of strategy/prompt — detects strategy changes across sessions" },
                  { field: "instruction_received_at", type: "ISO 8601", desc: "When the agent received the task from the orchestrator" },
                  { field: "reasoning_started_at", type: "ISO 8601", desc: "When the agent began forming the declared decision basis" },
                  { field: "action_taken_at", type: "ISO 8601", desc: "When the action was executed (must be after proof_id is returned)" },
                  { field: "jurisdiction_type", type: "string", desc: "Legal context for compliance gating (e.g. 'EU-AI-Act', 'SEC-regulated')" },
                  { field: "session_id", type: "string", desc: "Links multiple proofs in the same agent session — used by investigate_proof" },
                ].map((row, i) => (
                  <tr key={row.field} className={`border-b border-border/40 ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
                    <td className="py-2 px-2 font-mono text-primary text-xs">{row.field}</td>
                    <td className="py-2 px-2 text-muted-foreground/70 text-xs whitespace-nowrap">{row.type}</td>
                    <td className="py-2 px-2 text-muted-foreground text-xs">{row.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CodeBlock lang="json" code={`// Example: classification-only metadata on a high-stakes action.
// The declared decision basis (the WHAT/WHY text and inputs) is hashed locally and
// stays there — it is NOT sent. Only fixed, intentionally disclosable fields travel:
// role/action_type, sanitized category, opaque IDs, hashes, and timestamps.
{
  "file_hash": "a1b2c3...64hex",
  "filename": "trade_decision_001.json",
  "metadata": {
    "who": "trading-agent-v3",
    "action_type": "trade_execution",
    "category": "finance",
    "confidence_score": 0.87,
    "reversibility_class": "costly",
    "model_hash": "sha256_of_gpt4o_weights_snapshot",
    "instruction_received_at": "2026-06-13T14:29:50Z",
    "reasoning_started_at": "2026-06-13T14:29:52Z",
    "action_taken_at": "2026-06-13T14:30:01Z",
    "session_id": "sess_abc123",
    "decision_id": "dec_abc123",
    "jurisdiction_type": "SEC-regulated"
  }
}`} />
          <p className="text-xs text-muted-foreground">
            All metadata is optional. The minimum valid proof is just <code className="font-mono bg-muted px-1 rounded text-xs">file_hash</code> + <code className="font-mono bg-muted px-1 rounded text-xs">filename</code>. The richer the metadata, the more useful the audit trail.
          </p>
        </div>
      ),
    },
    {
      id: "integrations",
      icon: Network,
      title: "Framework integrations — LangChain, CrewAI, AutoGen, LlamaIndex, OpenAI Agents SDK",
      badge: "Copy-paste ready",
      content: (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act integrates with every major agent framework. All examples use the same core pattern: <strong className="text-foreground">hash locally → anchor before action → proceed with proof_id</strong>.
          </p>

          <div>
            <p className="text-xs font-semibold mb-2">LangChain (Python)</p>
            <CodeBlock lang="python" code={`from langchain.tools import tool
from xproof import xproof  # legacy module name; install: pip install prove-before-act

@tool
def prove_before_act(declared_basis: str, action_type: str) -> str:
    """
    Anchor a declared decision basis on-chain before executing any significant action.
    declared_basis: human-readable summary of WHY — NOT raw prompts or chain-of-thought.
    """
    # content is hashed locally by the SDK; the basis text never leaves the machine.
    # Metadata is classification-only — no basis text, rationale/why, or action content.
    proof = xproof.anchor(
        content=declared_basis,
        metadata={"who": "langchain-agent", "action_type": action_type}
    )
    return f"Proof anchored: {proof.verify_url}"

# Add to your agent's tools list — call before any high-stakes action
tools = [prove_before_act, ...]`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">CrewAI (Python)</p>
            <CodeBlock lang="python" code={`from crewai import Agent, Task
from xproof import xproof  # legacy module name; install: pip install prove-before-act

def anchor_before_kickoff(crew_inputs: dict) -> str:
    # Summarize the declared decision basis — not raw prompts or step-by-step deliberation
    declared_basis = f"Crew kickoff: goal={crew_inputs.get('goal', 'unspecified')}, context={crew_inputs.get('context', 'none')}"
    # content is hashed locally by the SDK — the basis stays local.
    # Metadata is classification-only: fixed role + action_type, nothing derived from the basis.
    proof = xproof.anchor(
        content=declared_basis,
        metadata={"who": "crewai-orchestrator", "action_type": "crew_kickoff"}
    )
    return proof.id  # attach proof_id to crew context

# Use in crew callbacks or as a pre-task hook
crew = Crew(agents=[...], tasks=[...], step_callback=anchor_before_kickoff)`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">OpenAI Agents SDK (Python)</p>
            <CodeBlock lang="python" code={`from agents import Agent, function_tool
from xproof import xproof  # legacy module name; install: pip install prove-before-act

@function_tool
def anchor_decision_basis(declared_basis: str, action_type: str) -> str:
    """
    Prove Before Act — anchor a declared decision basis before execution. Returns proof_id.
    declared_basis: summary of WHY — NOT internal chain-of-thought or raw prompts.
    """
    # content is hashed locally by the SDK; the basis stays local.
    # Metadata is classification-only — no basis text or action content is sent.
    proof = xproof.anchor(
        content=declared_basis,
        metadata={"who": "openai-agent", "action_type": action_type}
    )
    return proof.id

agent = Agent(
    name="AccountableAgent",
    instructions="Always call anchor_decision_basis BEFORE executing any significant action. Pass a clear declared decision basis — not your internal reasoning steps.",
    tools=[anchor_decision_basis, ...]
)`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">AutoGen (Python)</p>
            <CodeBlock lang="python" code={`from autogen import ConversableAgent
from xproof import xproof  # legacy module name; install: pip install prove-before-act

def pre_action_hook(sender, message, recipient, request_reply):
    """
    Hook: anchor a declared decision basis for every outbound action before it is processed.
    Only anchors the action declaration — not the full internal message thread or chain-of-thought.
    """
    if request_reply and "action:" in message.get("content", "").lower():
        # Extract the declared action line only — not the full message content
        action_line = next(
            (ln for ln in message["content"].splitlines() if "action:" in ln.lower()), ""
        )
        # action_line is hashed locally as the basis and never sent.
        # Metadata is classification-only: fixed role + action_type, no message content.
        xproof.anchor(
            content=action_line or message["content"][:200],
            metadata={"who": sender.name, "action_type": "message_action"}
        )

agent = ConversableAgent(name="my-agent", ...)
agent.register_hook("process_message_before_send", pre_action_hook)`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">LlamaIndex (Python)</p>
            <CodeBlock lang="python" code={`from llama_index.core.tools import FunctionTool
from xproof import xproof  # legacy module name; install: pip install prove-before-act

def anchor_decision_basis(declared_basis: str, action_type: str) -> str:
    """
    declared_basis: declared decision basis (WHY) — NOT internal chain-of-thought or prompts.
    """
    # content is hashed locally by the SDK; the basis stays local.
    # Metadata is classification-only — no basis text or action content is sent.
    proof = xproof.anchor(
        content=declared_basis,
        metadata={"who": "llamaindex-agent", "action_type": action_type}
    )
    return f"proof_id={proof.id} verify={proof.verify_url}"

xproof_tool = FunctionTool.from_defaults(
    fn=anchor_decision_basis,
    name="anchor_decision_basis",
    description="Anchor a declared decision basis BEFORE executing any action. Pass WHY, not chain-of-thought."
)
agent = ReActAgent.from_tools([xproof_tool, ...], llm=llm)`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">Vercel AI SDK (TypeScript)</p>
            <CodeBlock lang="typescript" code={`import { tool } from 'ai';
import { z } from 'zod';
import { xProof } from 'prove-before-act';  // npm install prove-before-act

// INVARIANT: declaredBasis must be a human-readable declared decision basis (WHY + key inputs).
// Never pass internal chain-of-thought, hidden reasoning steps, raw prompts, or
// step-by-step deliberation into this field or any metadata sent to the API.
const anchorTool = tool({
  description: 'Anchor a declared decision basis on-chain BEFORE executing any significant action. Returns proof_id.',
  parameters: z.object({
    declaredBasis: z.string().describe('The declared decision basis (WHY) — not internal chain-of-thought or prompts'),
    actionType: z.string().describe('A fixed action classification, e.g. "trade_execution"'),
  }),
  execute: async ({ declaredBasis, actionType }) => {
    // content is hashed locally by the SDK — the basis stays local.
    // Metadata is classification-only: no basis text, rationale/why, or action content.
    const proof = await xproof.anchor({
      content: declaredBasis,
      metadata: { who: 'vercel-ai-agent', action_type: actionType },
    });
    return { proof_id: proof.id, verify_url: proof.verifyUrl };
  },
});`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">Fetch.ai / uAgents (Python)</p>
            <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
              Prove Before Act integrates natively with the Fetch.ai Agentverse ecosystem via <code className="font-mono bg-muted px-1 rounded">XProofuAgentMiddleware</code>. Every uAgent message handler automatically anchors a WHY proof before processing and a WHAT proof after — making your Fetch.ai agent auditable and trust-scored on the Prove Before Act leaderboard.
            </p>
            <CodeBlock lang="python" code={`from uagents import Agent, Context
from xproof.integrations.fetchai import XProofuAgentMiddleware

agent = Agent(name="my-fetchai-agent", seed="your_seed_phrase")

# One-line integration — anchors proof before every message handler
XProofuAgentMiddleware(agent, api_key="pm_YOUR_KEY")

@agent.on_message(model=MyMessage)
async def handle(ctx: Context, sender: str, msg: MyMessage):
    # Proof is already anchored before this line executes
    await ctx.send(sender, MyResponse(result="processed"))

# Full example: github.com/jasonxkensei/prove-before-act-examples/tree/main/fetchai`} />
          </div>

          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-2">Install the SDKs</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground font-mono mb-1"># Python</p>
                <code className="text-xs bg-muted px-2 py-1 rounded block">pip install prove-before-act</code>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-mono mb-1">// JavaScript / TypeScript</p>
                <code className="text-xs bg-muted px-2 py-1 rounded block">npm install prove-before-act</code>
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "honest",
      icon: AlertTriangle,
      title: "What experienced agents should know before deploying",
      badge: "Honest assessment",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            This section exists because credibility matters more than marketing. Prove Before Act is a pragmatic, production-ready tool — and like any tool, it has genuine trade-offs. Knowing them before you integrate is more valuable than discovering them after.
          </p>

          {/* Real limitations */}
          <div className="space-y-3">
            {[
              {
                limitation: "MultiversX dependency",
                honest: "Your proofs live on MultiversX. If you're already deep in the EVM ecosystem, that's a cross-chain commitment. MultiversX has been live since 2020 with 99.9%+ uptime, but it's not Ethereum.",
                mitigation: "The proof_id and SHA-256 hash are blockchain-agnostic. You can replicate the hash to another chain later. Prove Before Act itself stores the full record off-chain too — your verify URL stays live regardless of MultiversX status.",
                severity: "low",
              },
              {
                limitation: "SDK tooling is still growing",
                honest: "The Python and JS SDKs are functional but younger than LangChain's tooling. Community-contributed integrations (AutoGen, CrewAI adapters) are at v0.x. Expect rough edges.",
                mitigation: "The REST API is stable and fully documented. Every framework integration ultimately reduces to a few HTTP calls. If the SDK has a bug, the raw API fallback always works — and we welcome PRs.",
                severity: "low",
              },
              {
                limitation: "Prove Before Act is newer than alternatives",
                honest: "Arweave has been running since 2018. Sign Protocol has larger EVM adoption. Prove Before Act launched in 2024. If 'battle-tested for 5+ years' is a hard requirement, be aware of this.",
                mitigation: "Review the reference agent's current public proof history and the live status of each proof. The underlying blockchain (MultiversX) has an independent operational history; this does not guarantee application-level behavior.",
                severity: "medium",
              },
              {
                limitation: "Not the right tool for every use case",
                honest: "Prove Before Act is optimized for agent decision accountability, not arbitrary file archiving. If you need to store terabytes of files permanently, Arweave is better. If you need EVM-native attestations with existing Solidity tooling, Sign Protocol is better.",
                mitigation: "Use Prove Before Act for what it's best at: Prove Before Act, agent audit trails, 4W accountability, and trust score building. It's a complement to storage layers, not a replacement.",
                severity: "info",
              },
            ].map((item) => (
              <div key={item.limitation} className={`rounded-md border p-3 ${item.severity === "medium" ? "border-yellow-500/20 bg-yellow-500/5" : item.severity === "info" ? "border-border bg-muted/20" : "border-border bg-muted/20"}`}>
                <div className="flex items-start gap-2 mb-2">
                  <AlertTriangle className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${item.severity === "medium" ? "text-yellow-500" : "text-muted-foreground"}`} />
                  <p className="text-xs font-semibold">{item.limitation}</p>
                </div>
                <p className="text-xs text-muted-foreground mb-2 pl-5">{item.honest}</p>
                <div className="pl-5 flex items-start gap-1.5">
                  <CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
                  <p className="text-xs text-muted-foreground/80">{item.mitigation}</p>
                </div>
              </div>
            ))}
          </div>

          {/* When to use vs not */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
              <p className="text-xs font-semibold text-primary mb-2">Use Prove Before Act when</p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-primary" />You need Prove Before Act — proof of a declared decision basis BEFORE action</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-primary" />You want zero-account machine payments (x402 + USDC on Base)</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-primary" />You want a public trust score + audit trail for your agent</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-primary" />Privacy matters — only the hash is public, content stays local</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-primary" />You want 4W forensic reconstruction if something goes wrong</li>
              </ul>
            </div>
            <div className="rounded-md border border-muted p-3">
              <p className="text-xs font-semibold mb-2">Consider alternatives when</p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li className="flex items-start gap-1.5"><span className="text-muted-foreground/60 shrink-0 mt-0.5">→</span>You need to store full file content on-chain (use Arweave)</li>
                <li className="flex items-start gap-1.5"><span className="text-muted-foreground/60 shrink-0 mt-0.5">→</span>You need EVM-native Solidity attestations (use Sign Protocol)</li>
                <li className="flex items-start gap-1.5"><span className="text-muted-foreground/60 shrink-0 mt-0.5">→</span>Your stack is 100% EVM and adding MultiversX is a blocker</li>
                <li className="flex items-start gap-1.5"><span className="text-muted-foreground/60 shrink-0 mt-0.5">→</span>You need a 5+ year battle-tested protocol as a hard requirement</li>
              </ul>
            </div>
          </div>

          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">Bottom line:</strong> Prove Before Act is the right choice for agents that need to prove a declared decision basis before acting — especially at low cost, with x402, and without a pre-existing account. It is not trying to replace Arweave or Sign Protocol. It fills the gap they do not cover: pre-execution accountability at {priceStr}/proof (live rate).
            </p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <PublicSiteHeader primaryActionHref="/#free-trial" />

      <main className="container py-10 max-w-4xl">
        {/* Page header */}
        <div className="mb-10">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Badge variant="outline" className="text-xs">
              <Bot className="mr-1.5 h-3 w-3" />
              Agent Context Document
            </Badge>
            <Badge variant="outline" className="text-xs">
              <Zap className="mr-1.5 h-3 w-3 text-primary" />
              LLM-optimized
            </Badge>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              Last updated July 2026
            </Badge>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              <Network className="mr-1.5 h-3 w-3" />
              Discoverable via llms.txt + /.well-known/provebeforeact.json
            </Badge>
          </div>
            <h1 className="text-3xl sm:text-4xl font-bold mb-3 tracking-tight" data-testid="text-agent-context-title">
              The accountability pattern for autonomous agents
          </h1>
            <p className="text-muted-foreground text-base leading-relaxed max-w-2xl mb-4" data-testid="text-agent-context-positioning">
              <strong className="text-foreground">Prove Before Act is the pattern; xProof is the reference implementation.</strong>{" "}
              Anchor a declared decision basis before execution: hash locally → certify on MultiversX → proceed only after checking the returned <code className="font-mono text-sm bg-muted px-1 rounded">proof_id</code> status. This is not a request for internal chain-of-thought. <a href="/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9" className="text-primary underline">View the reference agent's live profile</a>. <a href="/founder" className="text-primary underline">Meet Jason Petitfourg, the AI Product Builder behind Prove Before Act</a>.
          </p>
          {/* Integrator invariant — always visible */}
          <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3" data-testid="banner-integrator-invariant">
            <p className="text-xs font-bold text-red-600 dark:text-red-400 mb-1 uppercase tracking-wide">Integrator invariant — read before copying any snippet</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Only declared decision bases may be anchored.</strong> A declared decision basis is a concise, human-readable summary of <em>why</em> the agent is acting, what key inputs drove the decision, and what action was chosen. It is explicitly <strong className="text-foreground">not</strong> and must <strong className="text-foreground">never</strong> be: private chain-of-thought, hidden reasoning steps, raw system or user prompts, internal scratchpad text, or any step-by-step deliberation that the user or operator did not intend to be public. Sending private deliberation would violate user privacy, potentially expose proprietary prompts, and defeat the purpose of the hash-only privacy model. Hash the declared decision basis locally; the hash — not the content — is what gets sent to the API.
            </p>
          </div>

          {/* x402 — first thing agents see */}
          <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3" data-testid="badge-x402-top">
            <Zap className="h-4 w-4 text-primary shrink-0" />
            <p className="text-sm font-semibold">
              No API key needed. Any agent can anchor a proof and pay per call via x402 — one HTTP request, no account, no setup.
            </p>
          </div>

          {/* PBA Specification reference */}
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" data-testid="badge-standard-link">
            <ExternalLink className="h-3 w-3 shrink-0 text-primary/70" />
            <span>
              The Prove Before Act specification is at{" "}
              <a href="/standard" className="text-primary underline font-medium hover:text-primary/80 transition-colors">
                provebeforeact.com/standard
              </a>{" "}
              — design pattern, core invariant, 4W audit trail, and reference implementation.
            </span>
          </div>

          {/* Quick Start — visible before accordion */}
          <div className="mt-6 rounded-md border border-border bg-muted/10 p-4" data-testid="section-quickstart">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Quick Start — 3 steps</p>
              <div className="flex gap-2 flex-wrap">
                <Button asChild size="sm" data-testid="button-quickstart-trial">
                  <a href="/#free-trial">
                    Get 10 free proofs
                    <ArrowRight className="ml-1.5 h-3 w-3" />
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm" data-testid="button-quickstart-x402">
                  <a href="#x402">x402 (no API key)</a>
                </Button>
              </div>
            </div>
            <CodeBlock lang="bash" code={`# 1. Get API key — no wallet, no card (10 free proofs)
curl -X POST https://provebeforeact.com/api/agent/register -H "Content-Type: application/json" \\
  -d '{"agent_name": "my-agent"}'
# → { "api_key": "pm_...", "trial": { "quota": 10 } }

# 2. Hash the declared decision basis locally (raw content never leaves your machine)
#    Use a declared decision basis — not internal chain-of-thought or raw prompts
FILE_HASH=$(python3 -c "import hashlib,json; print(hashlib.sha256(json.dumps({'why':'RSI=38','what':'BUY BTC'},sort_keys=True).encode()).hexdigest())")

# 3. Anchor BEFORE executing — Prove Before Act
#    The basis stays local; only file_hash + classification-only metadata are sent
#    (fixed action_type + sanitized category — never the basis text, why, or outcome)
curl -X POST https://provebeforeact.com/api/proof -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{\"file_hash\":\"$FILE_HASH\",\"filename\":\"decision_basis.json\",\"metadata\":{\"who\":\"my-agent\",\"action_type\":\"trade_execution\",\"category\":\"finance\"}}"
# → { "proof_id": "prf_...", "verify_url": "/proof/...", "status": "pending" }`} />
          </div>

          {/* Use-case examples */}
          <div className="mt-6 rounded-md border border-border bg-muted/10 p-4 space-y-5" data-testid="section-usecases">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">By use case — copy-paste ready</p>
              <div className="flex gap-1" data-testid="toggle-example-lang">
                <button
                  onClick={() => setExampleLang("python")}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors font-mono ${exampleLang === "python" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                  data-testid="button-lang-python"
                >Python</button>
                <button
                  onClick={() => setExampleLang("typescript")}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors font-mono ${exampleLang === "typescript" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                  data-testid="button-lang-typescript"
                >TypeScript</button>
              </div>
            </div>
            {/* Use-case overview cards */}
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { id: "trading", icon: TrendingUp, label: "Trading agent", context: "Finance · High-value decisions", desc: "Prove a BUY/SELL decision before executing. Full 4W audit trail on-chain." },
                { id: "research", icon: Eye, label: "Research agent", context: "Content · Reports · Analysis", desc: "Anchor a declared decision basis + sources before publishing. Verifiable provenance for readers." },
                { id: "support", icon: Shield, label: "Support agent", context: "Customer service · Compliance", desc: "Certify decision before sending response. Dispute-proof audit record." },
              ].map((uc) => (
                <div key={uc.id} className="rounded-md border bg-background p-3">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <uc.icon className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="text-sm font-semibold">{uc.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1">{uc.context}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{uc.desc}</p>
                </div>
              ))}
            </div>
            {[
              {
                id: "trading",
                label: "Trading agent",
                context: "Finance · High-value decisions",
                desc: "Prove a BUY/SELL decision before executing — full 4W audit trail anchored on-chain",
                codePy: `import hashlib, json, requests

# 1. Declare a decision basis — key inputs + rationale + chosen action
#    NOT internal chain-of-thought, hidden reasoning steps, or raw prompts
decision_basis = {
    "who": "trading-agent-v2", "what": "BUY BTC 0.5",
    "why": "RSI=38 (below 40 threshold); allocation=2.1% (below 3% cap)",
    "model": "gpt-4o-mini", "session_id": "sess_001"
}
# Hash the basis locally — the basis object stays on this machine, only its hash is sent
h = hashlib.sha256(json.dumps(decision_basis, sort_keys=True).encode()).hexdigest()

# 2. Anchor BEFORE executing — metadata is classification-only (fixed action_type +
#    sanitized category + opaque IDs). Never send the basis object, why, or inputs.
metadata = {
    "who": "trading-agent-v2", "action_type": "trade_execution",
    "category": "finance", "model": "gpt-4o-mini",
    "session_id": "sess_001", "decision_id": "dec_001",
}
resp = requests.post("https://provebeforeact.com/api/proof",
    headers={"Authorization": "Bearer pm_YOUR_KEY"},
    json={"file_hash": h, "filename": "trade_decision.json", "metadata": metadata})
proof_id = resp.json()["proof_id"]  # returned in ~1.1s, on-chain in ~6s

# 3. Execute only after proof is anchored
execute_trade("BUY", "BTC", 0.5)
print(f"Audit trail: https://provebeforeact.com/proof/{proof_id}")`,
                codeTs: `import crypto from "crypto";

// 1. Declare a decision basis — key inputs + rationale + chosen action
// NOT internal chain-of-thought, hidden reasoning steps, or raw prompts
const decisionBasis = {
  who: "trading-agent-v2", what: "BUY BTC 0.5",
  why: "RSI=38 (below 40 threshold); allocation=2.1% (below 3% cap)",
  model: "gpt-4o-mini", session_id: "sess_001",
};
// Hash the basis locally — the basis object stays local, only its hash is sent
const sorted = JSON.stringify(decisionBasis, Object.keys(decisionBasis).sort() as any);
const h = crypto.createHash("sha256").update(sorted).digest("hex");

// 2. Anchor BEFORE executing — metadata is classification-only (fixed action_type +
// sanitized category + opaque IDs). Never send the basis object, why, or inputs.
const metadata = {
  who: "trading-agent-v2", action_type: "trade_execution",
  category: "finance", model: "gpt-4o-mini",
  session_id: "sess_001", decision_id: "dec_001",
};
const resp = await fetch("https://provebeforeact.com/api/proof", {
  method: "POST",
  headers: { Authorization: "Bearer pm_YOUR_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ file_hash: h, filename: "trade_decision.json", metadata }),
});
const { proof_id } = await resp.json() as { proof_id: string };
// returned in ~1.1s, on-chain in ~6s

// 3. Execute only after proof is anchored
await executeTrade("BUY", "BTC", 0.5);
console.log("Audit trail: https://provebeforeact.com/proof/" + proof_id);`,
              },
              {
                id: "research",
                label: "Research agent",
                context: "Content · Reports · Analysis",
                desc: "Anchor a declared decision basis + sources before publishing — verifiable provenance for readers",
                codePy: `import hashlib, json, requests

# 1. Summarize the declared decision basis and sources
#    NOT internal chain-of-thought, hidden reasoning steps, or raw prompts
decision_basis = {
    "who": "research-agent-v1", "what": "Publish Q2 crypto market outlook",
    "why": "5 sources reviewed, confidence=0.87, no contradictions detected",
    "sources": ["arxiv:2406.12345", "bloomberg:BTC-Q2", "coindesk:2026-07-01"]
}
# Hash the basis locally — the basis (why + sources) stays local, only its hash is sent
h = hashlib.sha256(json.dumps(decision_basis, sort_keys=True).encode()).hexdigest()

# 2. Anchor hash — report content, rationale, and sources never leave the agent.
#    Metadata is classification-only: fixed action_type + sanitized category + opaque ID.
metadata = {
    "who": "research-agent-v1", "action_type": "publish",
    "category": "research", "decision_id": "dec_research_001",
}
resp = requests.post("https://provebeforeact.com/api/proof",
    headers={"Authorization": "Bearer pm_YOUR_KEY"},
    json={"file_hash": h, "filename": "research_decision_basis.json", "metadata": metadata})
proof_id = resp.json()["proof_id"]

# 3. Publish with verifiable provenance link
publish_report(report_content, audit_ref=proof_id)
print(f"Readers can verify: https://provebeforeact.com/proof/{proof_id}")`,
                codeTs: `import crypto from "crypto";

// 1. Summarize the declared decision basis and sources
// NOT internal chain-of-thought, hidden reasoning steps, or raw prompts
const decisionBasis = {
  who: "research-agent-v1", what: "Publish Q2 crypto market outlook",
  why: "5 sources reviewed, confidence=0.87, no contradictions detected",
  sources: ["arxiv:2406.12345", "bloomberg:BTC-Q2", "coindesk:2026-07-01"],
};
// Hash the basis locally — the basis (why + sources) stays local, only its hash is sent
const sorted = JSON.stringify(decisionBasis, Object.keys(decisionBasis).sort() as any);
const h = crypto.createHash("sha256").update(sorted).digest("hex");

// 2. Anchor hash — report content, rationale, and sources never leave the agent.
// Metadata is classification-only: fixed action_type + sanitized category + opaque ID.
const metadata = {
  who: "research-agent-v1", action_type: "publish",
  category: "research", decision_id: "dec_research_001",
};
const resp = await fetch("https://provebeforeact.com/api/proof", {
  method: "POST",
  headers: { Authorization: "Bearer pm_YOUR_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ file_hash: h, filename: "research_decision_basis.json", metadata }),
});
const { proof_id } = await resp.json() as { proof_id: string };

// 3. Publish with verifiable provenance link
await publishReport(reportContent, { audit_ref: proof_id });
console.log("Readers can verify: https://provebeforeact.com/proof/" + proof_id);`,
              },
              {
                id: "support",
                label: "Support agent",
                context: "Customer service · Compliance",
                desc: "Certify decision before sending response — dispute-proof audit record",
                codePy: `import hashlib, json, requests

# 1. Document the declared decision basis — policy applied and outcome
#    NOT internal chain-of-thought or full conversation transcript
decision_basis = {
    "who": "support-agent-v3", "what": "Refund $47.50 approved",
    "why": "Policy §3.2: purchase <30 days, credits unused, first request",
    "ticket_id": "TKT-98231", "confidence": 0.95
}
# Hash the basis locally — the policy applied, outcome, and ticket ID stay local
h = hashlib.sha256(json.dumps(decision_basis, sort_keys=True).encode()).hexdigest()

# 2. Certify before sending — creates dispute-proof audit record.
#    Metadata is classification-only: fixed action_type + sanitized category + opaque ID.
#    No why/policy details, ticket IDs, or outcome content are sent.
metadata = {
    "who": "support-agent-v3", "action_type": "refund_decision",
    "category": "customer_support", "decision_id": "dec_support_001",
}
resp = requests.post("https://provebeforeact.com/api/proof",
    headers={"Authorization": "Bearer pm_YOUR_KEY"},
    json={"file_hash": h, "filename": "support_decision.json", "metadata": metadata})
proof_id = resp.json()["proof_id"]

# 3. Send response with proof_id as audit reference
send_to_customer(ticket_id, response_text, audit_ref=proof_id)`,
                codeTs: `import crypto from "crypto";

// 1. Document the declared decision basis — policy applied and outcome
// NOT internal chain-of-thought or full conversation transcript
const decisionBasis = {
  who: "support-agent-v3", what: "Refund $47.50 approved",
  why: "Policy §3.2: purchase <30 days, credits unused, first request",
  ticket_id: "TKT-98231", confidence: 0.95,
};
// Hash the basis locally — the policy applied, outcome, and ticket ID stay local
const sorted = JSON.stringify(decisionBasis, Object.keys(decisionBasis).sort() as any);
const h = crypto.createHash("sha256").update(sorted).digest("hex");

// 2. Certify before sending — creates dispute-proof audit record.
// Metadata is classification-only: fixed action_type + sanitized category + opaque ID.
// No why/policy details, ticket IDs, or outcome content are sent.
const metadata = {
  who: "support-agent-v3", action_type: "refund_decision",
  category: "customer_support", decision_id: "dec_support_001",
};
const resp = await fetch("https://provebeforeact.com/api/proof", {
  method: "POST",
  headers: { Authorization: "Bearer pm_YOUR_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ file_hash: h, filename: "support_decision.json", metadata }),
});
const { proof_id } = await resp.json() as { proof_id: string };

// 3. Send response with proof_id as audit reference
await sendToCustomer(ticketId, responseText, { audit_ref: proof_id });`,
              },
            ].map((uc) => (
              <div key={uc.id} data-testid={`example-usecase-${uc.id}`}>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <Badge variant="secondary" className="text-xs">{uc.label}</Badge>
                  <span className="text-xs text-muted-foreground">{uc.context}</span>
                </div>
                <p className="text-xs text-muted-foreground mb-0.5">{uc.desc}</p>
                <CodeBlock
                  lang={exampleLang === "python" ? "python" : "typescript"}
                  code={exampleLang === "python" ? uc.codePy : uc.codeTs}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Production Ready callout */}
        <div className="mb-8 rounded-md border border-amber-500/25 bg-amber-500/5 p-4" data-testid="section-production-callout">
          <div className="flex items-start gap-3 mb-3">
            <Cog className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold">Going to production?</p>
              <p className="text-xs text-muted-foreground mt-0.5">Four patterns your deployment needs before going live.</p>
            </div>
            <Button asChild variant="outline" size="sm" className="ml-auto shrink-0" data-testid="button-production-section">
              <a href="#production">See examples <ArrowRight className="ml-1 h-3 w-3" /></a>
            </Button>
          </div>
          <ul className="grid gap-1.5 sm:grid-cols-2 text-xs text-muted-foreground">
            <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-amber-500" /><span><strong className="text-foreground">Batch anchoring</strong> — up to 50 files per call, 50× fewer requests</span></li>
            <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-amber-500" /><span><strong className="text-foreground">Retry policy</strong> — exponential backoff, 409 dedup, Retry-After support</span></li>
            <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-amber-500" /><span><strong className="text-foreground">Monitoring</strong> — alert if daily proof volume drops unexpectedly</span></li>
            <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-amber-500" /><span><strong className="text-foreground">Operator policy: no proof = no action</strong> — an optional hard gate for high-stakes decisions</span></li>
          </ul>
        </div>

        {/* Table of contents */}
        <div className="mb-8 rounded-md border bg-muted/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">14 topics covered</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {sections.map((s, i) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors py-0.5"
              >
                <span className="text-primary/60 font-mono w-4 shrink-0">{i + 1}.</span>
                {s.title.split("?")[0].replace(/How does |What is |What to |How to |How does |Can you |Complete /, "")}
                {s.badge && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-auto">{s.badge}</Badge>}
              </a>
            ))}
          </div>
        </div>

        {/* Sections */}
        <div className="space-y-4" id="sections">
          {sections.map((section) => {
            const Icon = section.icon;
            const isOpen = expandedSections[section.id];
            return (
              <Card key={section.id} id={section.id} data-testid={`card-section-${section.id}`}>
                <CardHeader
                  className="cursor-pointer select-none"
                  onClick={() => toggle(section.id)}
                >
                  <CardTitle className="flex items-start justify-between gap-3 text-base font-semibold">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
                        <Icon className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <span className="leading-snug">{section.title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 mt-0.5">
                      {section.badge && (
                        <Badge variant="secondary" className="text-xs hidden sm:flex">
                          {section.badge}
                        </Badge>
                      )}
                      {isOpen ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </CardTitle>
                </CardHeader>
                {isOpen && (
                  <CardContent className="pt-0">
                    {section.content}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>

        {/* Footer CTA */}
        <div className="mt-10 rounded-md border border-primary/20 bg-primary/5 p-6 space-y-4">
          <div>
            <p className="text-base font-bold mb-1">Ready to prove your agent's intent?</p>
            <p className="text-xs text-muted-foreground">Start with 10 free certs — no wallet, no card. Scale with x402 or a prepaid API key. Full on-chain audit trail from day one.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" data-testid="link-footer-register">
              <a href="/#free-trial">
                Get 10 free certs — no wallet
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" data-testid="link-footer-leaderboard">
              <a href="/leaderboard">
                Agent leaderboard
              </a>
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {[
              { label: "REST API docs", href: "/docs" },
              { label: "PBA specification", href: "/standard" },
              { label: "llms.txt", href: "/llms.txt" },
              { label: "MCP endpoint", href: "https://provebeforeact.com/mcp" },
              { label: "Moltbook case study", href: "/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9" },
            ].map((link) => (
              <Button key={link.label} asChild variant="ghost" size="sm" data-testid={`link-footer-${link.label.replace(/\s+/g, "-").toLowerCase()}`}>
                <a href={link.href} target={link.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">
                  {link.label}
                </a>
              </Button>
            ))}
          </div>
        </div>
      </main>
      <PublicSiteFooter />
    </div>
  );
}
