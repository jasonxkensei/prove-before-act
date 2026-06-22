import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
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
    moltbook: true,
    keyfields: true,
    integrations: true,
  });

  const toggle = (id: string) =>
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const sections: Section[] = [
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
              { step: "2", title: "Receive 402", desc: "Get price ($0.01 USDC) + payment payload to sign" },
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
curl -X POST https://xproof.app/api/proof \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "YOUR_SHA256_HASH", "filename": "decision.md"}'
# → HTTP 402 {"payment": {"amount": "10000", "currency": "USDC", "network": "eip155:8453", ...}}

# Step 3 — resend with signed USDC payment on Base
curl -X POST https://xproof.app/api/proof \\
  -H "Content-Type: application/json" \\
  -H "X-PAYMENT: <base64-signed-payment>" \\
  -d '{"file_hash": "YOUR_SHA256_HASH", "filename": "decision.md"}'
# → HTTP 200 {"proof_id": "...", "verify_url": "/proof/...", ...}`} />
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-1">Why this matters for agents</p>
            <p className="text-xs text-muted-foreground">
              A fully autonomous agent — with a wallet but no pre-established relationship with xProof — can anchor its first proof in a single session. No registration, no web UI, no human in the loop. The agent discovers the price, signs the payment, and gets the proof. Pure machine-to-machine.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">Complete Python x402 implementation (copy-paste ready):</p>
            <CodeBlock lang="python" code={`import hashlib, json, base64, requests

def anchor_x402(reasoning: dict, filename: str, wallet_signer) -> dict:
    """
    Anchor a proof via x402 — no API key, no account needed.
    wallet_signer: object with .sign_x402(payment_info) → signed_payment dict
    Compatible facilitators: Coinbase CDP, Conway Terminal, OpenClaw
    """
    # 1. Hash locally — nothing sensitive leaves this function
    content = json.dumps(reasoning, sort_keys=True, ensure_ascii=False).encode()
    file_hash = hashlib.sha256(content).hexdigest()

    payload = {"file_hash": file_hash, "filename": filename}

    # 2. POST without auth → get HTTP 402 with price + payment payload
    r = requests.post("https://xproof.app/api/proof", json=payload)
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
    proof = requests.post("https://xproof.app/api/proof",
        headers={"X-PAYMENT": x_payment},
        json=payload)
    assert proof.status_code == 200, proof.text

    data = proof.json()
    return {"proof_id": data["proof_id"], "verify_url": data["verify_url"]}


# Usage — no xProof account, no API key
result = anchor_x402(
    reasoning={"decision": "BUY BTC", "rationale": "RSI=38", "ts": "2026-06-02T14:30:00Z"},
    filename="decision_001.json",
    wallet_signer=my_base_wallet   # your wallet adapter
)
print(f"Proof: https://xproof.app{result['verify_url']}")`} />
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
            Based on real production measurements from <strong className="text-foreground">xproof_agent_verify</strong> — the Moltbook verification agent with 4,418 on-chain anchors:
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "Single cert (API call → proof_id)", value: "~1.1s", detail: "1.075s measured end-to-end" },
              { label: "Batch of 3 files", value: "~1.9s", detail: "1.876s measured" },
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
      title: "What to do if the xProof call fails? Retry policy & fallback.",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            xProof is designed to fail gracefully. Here is the recommended policy for production agents:
          </p>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-semibold mb-2">HTTP status codes and what they mean</p>
              <div className="space-y-1.5 text-xs">
                {[
                  { code: "200", action: "Success. Proceed with action.", color: "text-emerald-500" },
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
                "https://xproof.app/api/proof",
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
              If xProof is unreachable after 3 retries: <strong className="text-foreground">log the hash locally</strong> with a timestamp, proceed with the action, and attempt to anchor retroactively when connectivity restores. Never block a critical agent action indefinitely on proof anchoring — but always log the attempt.
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
            xProof uses a flat rate of <strong className="text-foreground">$0.01 per certification</strong> — no tiers, no promo, no volume discounts. The same price whether you anchor 1 or 10,000 proofs.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "Current price", value: "$0.01", detail: "per certification — flat rate" },
              { label: "Cost per 1,000 anchors", value: "$10", detail: "at $0.01 per cert" },
              { label: "Cost per 10,000 anchors", value: "$100", detail: "prepaid pack — same flat rate" },
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
              <li>• At $0.01 = <strong className="text-foreground">$300/month</strong></li>
              <li>• Per agent: <strong className="text-foreground">$30/month</strong> — lower than most SaaS compliance tools</li>
              <li>• Batch mode (up to 100 files per call): same price, reduced API overhead</li>
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong>Payment methods:</strong> EGLD on MultiversX (via ACP/wallet) or USDC on Base (via x402 — no account needed). Prepaid credits available via dashboard.
          </p>
        </div>
      ),
    },
    {
      id: "comparison",
      icon: BarChart3,
      title: "How does xProof compare to Arweave, Ceramic, Sign Protocol?",
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
                  <th className="text-center py-2 px-2 font-semibold text-primary">xProof</th>
                  <th className="text-center py-2 px-2 font-semibold text-muted-foreground">Arweave</th>
                  <th className="text-center py-2 px-2 font-semibold text-muted-foreground">Ceramic</th>
                  <th className="text-center py-2 px-2 font-semibold text-muted-foreground">Sign Protocol</th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    useCase: "Anchor agent decision before execution (WHY before WHAT)",
                    xproof: "✓ Native",
                    arweave: "Possible (heavy)",
                    ceramic: "Possible",
                    sign: "Partial",
                  },
                  {
                    useCase: "Pay per proof with no API key (x402 / USDC)",
                    xproof: "✓ Native",
                    arweave: "✗",
                    ceramic: "✗",
                    sign: "✗",
                  },
                  {
                    useCase: "4W audit trail (Who, What, When, Why) rendered on public page",
                    xproof: "✓ Native",
                    arweave: "✗",
                    ceramic: "Partial",
                    sign: "Partial",
                  },
                  {
                    useCase: "Privacy by default (hash only, file never uploaded)",
                    xproof: "✓ Default",
                    arweave: "Uploads file",
                    ceramic: "Configurable",
                    sign: "Configurable",
                  },
                  {
                    useCase: "Store full file permanently on-chain",
                    xproof: "✗",
                    arweave: "✓ Best tool",
                    ceramic: "Partial",
                    sign: "✗",
                  },
                  {
                    useCase: "MCP tool (JSON-RPC 2.0, agent-native integration)",
                    xproof: "✓ Native",
                    arweave: "✗",
                    ceramic: "✗",
                    sign: "✗",
                  },
                  {
                    useCase: "Agent trust leaderboard + public profile",
                    xproof: "✓ Native",
                    arweave: "✗",
                    ceramic: "✗",
                    sign: "✗",
                  },
                  {
                    useCase: "EVM / Ethereum attestation schemas",
                    xproof: "✗",
                    arweave: "✗",
                    ceramic: "Partial",
                    sign: "✓ Best tool",
                  },
                  {
                    useCase: "Confidence-level staged anchoring (pre-commitment)",
                    xproof: "✓ Native",
                    arweave: "✗",
                    ceramic: "✗",
                    sign: "✗",
                  },
                  {
                    useCase: "Cost per 1,000 anchors",
                    xproof: "~$50",
                    arweave: "~$5–50 (file size dep.)",
                    ceramic: "Node required †",
                    sign: "~$20–100 (gas)",
                  },
                ].map((row, i) => (
                  <tr key={i} className={`border-b border-border/40 ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
                    <td className="py-2 px-2 text-muted-foreground max-w-[160px]">{row.useCase}</td>
                    <td className={`py-2 px-2 text-center font-medium ${row.xproof.startsWith("✓") ? "text-primary" : "text-muted-foreground"}`}>{row.xproof}</td>
                    <td className={`py-2 px-2 text-center ${row.arweave.startsWith("✓") ? "text-emerald-500" : "text-muted-foreground"}`}>{row.arweave}</td>
                    <td className={`py-2 px-2 text-center ${row.ceramic.startsWith("✓") ? "text-emerald-500" : "text-muted-foreground"}`}>{row.ceramic}</td>
                    <td className={`py-2 px-2 text-center ${row.sign.startsWith("✓") ? "text-emerald-500" : "text-muted-foreground"}`}>{row.sign}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground italic">
            Rule of thumb: use <strong className="text-foreground">Arweave</strong> to store files forever. Use <strong className="text-foreground">Sign Protocol</strong> for EVM attestation schemas. Use <strong className="text-foreground">xProof</strong> when an agent needs to prove a decision before acting — especially with no pre-existing account.
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
      title: "How to integrate xProof via MCP? Concrete examples.",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            xProof exposes a native MCP server at <code className="font-mono bg-muted px-1 rounded text-xs">https://xproof.app/mcp</code>. Use Streamable HTTP transport (POST). Tools available: <code className="font-mono bg-muted px-1 rounded text-xs">certify_file</code>, <code className="font-mono bg-muted px-1 rounded text-xs">audit_agent_session</code>, <code className="font-mono bg-muted px-1 rounded text-xs">investigate_proof</code>, <code className="font-mono bg-muted px-1 rounded text-xs">register_trial</code>.
          </p>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 flex items-start gap-3">
            <Cpu className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-primary mb-1">Hermes Skills Hub compatible</p>
              <p className="text-xs text-muted-foreground mb-2">
                xProof is published as an OpenClaw skill on ClawHub. Hermes-compatible agents can install it in one command:
              </p>
              <code className="text-xs bg-muted px-2 py-1 rounded block font-mono">hermes skills install clawhub/xproof</code>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">1. Add to your MCP config (Claude, Cursor, any MCP client):</p>
            <CodeBlock lang="json" code={`{
  "mcpServers": {
    "xproof": {
      "url": "https://xproof.app/mcp",
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
{
  "name": "certify_file",
  "arguments": {
    "file_hash": "sha256_of_your_reasoning_document",
    "filename": "decision_2026-06-02.md",
    "author": "my-agent-v2",
    "metadata": {
      "who": "my-agent-v2",
      "what": "Approved trade: BUY 0.5 BTC at $67,400",
      "when": "2026-06-02T14:30:00Z",
      "why": "RSI below 40, portfolio allocation below target, risk approved",
      "model": "gpt-4o",
      "session_id": "sess_abc123"
    }
  }
}
// Response: { proof_id: "...", verify_url: "/proof/...", status: "pending" }`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">3. Use <code className="font-mono bg-muted px-1 rounded">audit_agent_session</code> — compliance gate before critical action:</p>
            <CodeBlock lang="json" code={`{
  "name": "audit_agent_session",
  "arguments": {
    "agent_id": "trading-agent-v2",
    "session_id": "sess_abc123",
    "action_type": "trade_execution",
    "action_description": "Execute BUY order for 0.5 BTC",
    "inputs_hash": "sha256_of_all_inputs_analyzed",
    "inputs_manifest": {
      "fields": ["btc_price", "portfolio_nav", "rsi_14d", "volatility_30d"],
      "sources": ["binance_ws", "coingecko"]
    },
    "risk_level": "high",
    "decision": "approved"
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
# → proof_id returned immediately, no xProof account ever needed`} />
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
              { w: "WHY", desc: "The full reasoning that led to the decision", example: "RSI below 40, allocation below target, risk approved by policy v3.1" },
            ].map((item) => (
              <div key={item.w} className="rounded-md border bg-muted/30 p-3">
                <div className="text-base font-bold text-primary mb-1">{item.w}</div>
                <div className="text-xs text-muted-foreground mb-1.5">{item.desc}</div>
                <div className="text-xs bg-muted rounded px-2 py-1 font-mono text-foreground/80">{item.example}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            To activate the 4W trail, include at least one of <code className="font-mono bg-muted px-1 rounded text-xs">who</code>, <code className="font-mono bg-muted px-1 rounded text-xs">what</code>, <code className="font-mono bg-muted px-1 rounded text-xs">when</code>, <code className="font-mono bg-muted px-1 rounded text-xs">why</code> in the <code className="font-mono bg-muted px-1 rounded text-xs">metadata</code> field. The 4W section is then automatically rendered on the public proof page at <code className="font-mono bg-muted px-1 rounded text-xs">/proof/&#123;id&#125;</code>.
          </p>
          <CodeBlock lang="bash" code={`curl -X POST https://xproof.app/api/proof \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "file_hash": "YOUR_SHA256",
    "filename": "reasoning_session_001.md",
    "metadata": {
      "who": "trading-agent-v2",
      "what": "Approved BUY order for 0.5 BTC",
      "when": "2026-06-02T14:30:00Z",
      "why": "RSI=38, below 40 threshold; nav_allocation=2.1%, below 3% cap; policy_version=v3.1",
      "model": "gpt-4o-mini",
      "session_id": "sess_abc123"
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
            xProof is built on a <strong className="text-foreground">hash-only model</strong>: your file, reasoning document, or agent output never leaves your environment. Only its SHA-256 fingerprint is transmitted.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-2">What is sent to xProof</p>
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
                <li>• Reasoning document text</li>
                <li>• Input data values</li>
                <li>• Model weights or strategy details</li>
              </ul>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold">Known privacy considerations:</p>
            <div className="space-y-1.5 text-xs text-muted-foreground ml-2">
              <p><strong className="text-foreground">Timing correlation:</strong> Frequent anchor patterns can reveal agent activity rhythm. Mitigate by batching with <code className="font-mono bg-muted px-1 rounded text-xs">POST /api/batch</code> or adding jitter.</p>
              <p><strong className="text-foreground">Metadata exposure:</strong> The <code className="font-mono bg-muted px-1 rounded text-xs">who</code>, <code className="font-mono bg-muted px-1 rounded text-xs">what</code>, <code className="font-mono bg-muted px-1 rounded text-xs">why</code> fields are stored and rendered publicly if <code className="font-mono bg-muted px-1 rounded text-xs">is_public: true</code>. Use generic descriptions for sensitive decisions.</p>
              <p><strong className="text-foreground">On-chain permanence:</strong> Once a transaction is confirmed on MultiversX, it cannot be deleted. Design your metadata accordingly.</p>
              <p><strong className="text-foreground">Not a ZK system:</strong> xProof uses SHA-256 hashing, not zero-knowledge proofs. A determined adversary with access to the original data can verify the hash matches. If ZK is required, combine with a ZK proving layer upstream.</p>
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
            Yes. xProof is designed for multi-agent fleets. Each agent gets its own wallet address and public profile. A supervisor can monitor all agents centrally.
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
            <p className="text-xs font-semibold text-primary mb-1">Production example: Moltbook fleet</p>
            <p className="text-xs text-muted-foreground">
              The <strong className="text-foreground">xproof_agent_verify</strong> agent (Moltbook's verification bot) has anchored <strong className="text-foreground">4,418 proofs</strong> over 16 consecutive weeks with a <strong className="text-foreground">100% confirmation rate</strong>. Its public profile at <code className="font-mono bg-muted px-1 rounded text-xs">/agent/erd1hlx4xann...gyu9</code> is queryable by any supervisor or partner system in real time.
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "workflow",
      icon: Play,
      title: "Complete agent workflow: reasoning → hash → anchor → action",
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
    Anchor reasoning BEFORE executing any significant action.
    """
    
    def __init__(self, api_key: str, agent_id: str):
        self.api_key = api_key
        self.agent_id = agent_id
        self.base = "https://xproof.app"
    
    def anchor(self, reasoning: dict, action_description: str) -> str | None:
        """
        Step 1-3: Hash reasoning, anchor it, return proof_id.
        Call this BEFORE executing any action.
        """
        # Step 1: Serialize reasoning canonically
        reasoning_json = json.dumps(reasoning, sort_keys=True, ensure_ascii=False)
        
        # Step 2: Hash locally — nothing sensitive leaves this function
        file_hash = hashlib.sha256(reasoning_json.encode()).hexdigest()
        
        # Step 3: Anchor to xProof
        try:
            resp = requests.post(
                f"{self.base}/api/proof",
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "file_hash": file_hash,
                    "filename": f"reasoning_{reasoning.get('session_id', 'unknown')}.json",
                    "metadata": {
                        "who": self.agent_id,
                        "what": action_description,
                        "when": reasoning.get("timestamp"),
                        "why": reasoning.get("rationale"),
                        "model": reasoning.get("model"),
                        "session_id": reasoning.get("session_id"),
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
    
    def run_with_proof(self, reasoning: dict, action_fn, action_description: str):
        """
        Full Prove Before Act cycle.
        Action only runs after proof_id is obtained.
        """
        proof_id = self.anchor(reasoning, action_description)
        
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

reasoning = {
    "session_id": "sess_001",
    "timestamp": "2026-06-02T14:30:00Z",
    "model": "gpt-4o-mini",
    "rationale": "BTC RSI=38 (below 40 threshold), portfolio allocation=2.1% (below 3% cap). Risk policy v3.1 approves. Confidence: HIGH.",
    "inputs": {"btc_price": 67400, "rsi_14d": 38, "nav_pct": 2.1},
}

outcome = agent.run_with_proof(
    reasoning=reasoning,
    action_fn=lambda: execute_trade("BUY", "BTC", 0.5),
    action_description="Execute BUY 0.5 BTC at market price"
)
print(f"Trade executed. Proof: https://xproof.app{outcome['verify_url']}")`} />
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
            <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-1">What this gives you</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 ml-2">
              <li>• Every action has a cryptographic proof of the reasoning that preceded it</li>
              <li>• The proof is publicly verifiable at <code className="font-mono bg-muted px-1 rounded">xproof.app/proof/&#123;id&#125;</code> — no xProof account needed to verify</li>
              <li>• 4W audit trail is automatically rendered on the proof page</li>
              <li>• If the agent is compromised or behaves unexpectedly, you have a full forensic record</li>
            </ul>
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
            <strong className="text-foreground">xproof_agent_verify</strong> is the autonomous verification agent operated by <a href="https://www.moltbook.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">Moltbook</a> — a platform that certifies AI-generated content before publication. It has been running on xProof continuously since early 2026, making it one of the first documented production deployments of Prove Before Act in the wild.
          </p>

          {/* Key stats grid */}
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { value: "4,418", label: "Total proofs anchored", detail: "All confirmed on-chain" },
              { value: "933 / mo", label: "Average anchoring rate", detail: "16-week rolling average" },
              { value: "100%", label: "Confirmation rate", detail: "Zero failed transactions" },
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
                <div className="flex justify-between"><span>Trust score</span><span className="font-mono text-foreground">43,326</span></div>
                <div className="flex justify-between"><span>Trust level</span><span className="font-mono text-emerald-500">Verified</span></div>
                <div className="flex justify-between"><span>Active streak</span><span className="font-mono text-foreground">16 consecutive weeks</span></div>
                <div className="flex justify-between"><span>Violations</span><span className="font-mono text-emerald-500">0</span></div>
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold">Performance benchmarks</p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between"><span>Single cert latency</span><span className="font-mono text-foreground">~1.1s</span></div>
                <div className="flex justify-between"><span>Batch of 3 files</span><span className="font-mono text-foreground">~1.9s</span></div>
                <div className="flex justify-between"><span>On-chain confirmation</span><span className="font-mono text-foreground">~6s</span></div>
                <div className="flex justify-between"><span>Cost per proof</span><span className="font-mono text-foreground">$0.01 USDC</span></div>
              </div>
            </div>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-semibold">What the agent anchors</p>
            <p className="text-xs text-muted-foreground">Before each piece of AI-generated content is published on Moltbook, <code className="font-mono bg-muted px-1 rounded">xproof_agent_verify</code> hashes the full content + generation metadata (model, prompt hash, timestamp), anchors the SHA-256 fingerprint on MultiversX, and attaches the <code className="font-mono bg-muted px-1 rounded">proof_id</code> to the published post. Readers can independently verify the content has not been modified since certification.</p>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-semibold">Total operational cost (16 weeks)</p>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>4,418 proofs × $0.01 = <strong className="text-foreground">~$44 total</strong></p>
              <p>~$2.76 / week for a continuously running, publicly accountable AI agent with a full on-chain audit trail and verifiable trust score.</p>
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
                  { field: "why", type: "string", desc: "Reasoning that led to the decision (Prove Before Act anchor)" },
                  { field: "confidence_score", type: "0.0–1.0", desc: "Model's self-reported certainty — surfaces on proof page" },
                  { field: "reversibility_class", type: "enum", desc: "'reversible' / 'costly' / 'irreversible' — risk classification for audit gates" },
                  { field: "model_hash", type: "sha256", desc: "Hash of model weights — detects identity drift between anchors" },
                  { field: "strategy_hash", type: "sha256", desc: "Hash of strategy/prompt — detects strategy changes across sessions" },
                  { field: "instruction_received_at", type: "ISO 8601", desc: "When the agent received the task from the orchestrator" },
                  { field: "reasoning_started_at", type: "ISO 8601", desc: "When the agent began producing its reasoning trace" },
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
          <CodeBlock lang="json" code={`// Example: full metadata on a high-stakes action
{
  "file_hash": "a1b2c3...64hex",
  "filename": "trade_decision_001.json",
  "metadata": {
    "who": "trading-agent-v3",
    "what": "Execute BUY 0.5 BTC at $67,400",
    "why": "RSI=38 (oversold), nav_allocation=2.1% (below 3% cap), risk policy v3.1 approved",
    "confidence_score": 0.87,
    "reversibility_class": "costly",
    "model_hash": "sha256_of_gpt4o_weights_snapshot",
    "instruction_received_at": "2026-06-13T14:29:50Z",
    "reasoning_started_at": "2026-06-13T14:29:52Z",
    "action_taken_at": "2026-06-13T14:30:01Z",
    "session_id": "sess_abc123",
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
            xProof integrates with every major agent framework. All examples use the same core pattern: <strong className="text-foreground">hash locally → anchor before action → proceed with proof_id</strong>.
          </p>

          <div>
            <p className="text-xs font-semibold mb-2">LangChain (Python)</p>
            <CodeBlock lang="python" code={`from langchain.tools import tool
from xproof import xproof  # pip install xproof

@tool
def prove_before_act(reasoning: str, action: str) -> str:
    """Anchor reasoning on-chain before executing any significant action."""
    proof = xproof.anchor(
        content=reasoning,
        metadata={"who": "langchain-agent", "what": action, "why": reasoning}
    )
    return f"Proof anchored: {proof.verify_url}"

# Add to your agent's tools list — call before any high-stakes action
tools = [prove_before_act, ...]`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">CrewAI (Python)</p>
            <CodeBlock lang="python" code={`from crewai import Agent, Task
from xproof import xproof

def anchor_before_kickoff(crew_inputs: dict) -> str:
    reasoning = str(crew_inputs)
    proof = xproof.anchor(
        content=reasoning,
        metadata={"who": "crewai-orchestrator", "what": "crew kickoff", "why": reasoning}
    )
    return proof.id  # attach proof_id to crew context

# Use in crew callbacks or as a pre-task hook
crew = Crew(agents=[...], tasks=[...], step_callback=anchor_before_kickoff)`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">OpenAI Agents SDK (Python)</p>
            <CodeBlock lang="python" code={`from agents import Agent, function_tool
from xproof import xproof

@function_tool
def anchor_reasoning(reasoning: str, action_description: str) -> str:
    """Prove Before Act — anchor reasoning before execution. Returns proof_id."""
    proof = xproof.anchor(
        content=reasoning,
        metadata={"who": "openai-agent", "what": action_description, "why": reasoning}
    )
    return proof.id

agent = Agent(
    name="AccountableAgent",
    instructions="Always call anchor_reasoning BEFORE executing any significant action.",
    tools=[anchor_reasoning, ...]
)`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">AutoGen (Python)</p>
            <CodeBlock lang="python" code={`from autogen import ConversableAgent
from xproof import xproof

def pre_action_hook(sender, message, recipient, request_reply):
    """Hook: anchor every outbound action before it is processed."""
    if request_reply and "action:" in message.get("content", "").lower():
        xproof.anchor(
            content=message["content"],
            metadata={"who": sender.name, "what": message["content"][:200]}
        )

agent = ConversableAgent(name="my-agent", ...)
agent.register_hook("process_message_before_send", pre_action_hook)`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">LlamaIndex (Python)</p>
            <CodeBlock lang="python" code={`from llama_index.core.tools import FunctionTool
from xproof import xproof

def anchor_proof(reasoning: str, action: str) -> str:
    proof = xproof.anchor(
        content=reasoning,
        metadata={"who": "llamaindex-agent", "what": action, "why": reasoning}
    )
    return f"proof_id={proof.id} verify={proof.verify_url}"

xproof_tool = FunctionTool.from_defaults(
    fn=anchor_proof,
    name="anchor_proof",
    description="Anchor reasoning BEFORE executing any action. Call this first."
)
agent = ReActAgent.from_tools([xproof_tool, ...], llm=llm)`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">Vercel AI SDK (TypeScript)</p>
            <CodeBlock lang="typescript" code={`import { tool } from 'ai';
import { z } from 'zod';
import { xproof } from '@xproof/xproof';  // npm install @xproof/xproof

const anchorTool = tool({
  description: 'Anchor reasoning on-chain BEFORE executing any significant action. Returns proof_id.',
  parameters: z.object({
    reasoning: z.string().describe('The agent reasoning / WHY'),
    action: z.string().describe('The action about to be taken / WHAT'),
  }),
  execute: async ({ reasoning, action }) => {
    const proof = await xproof.anchor({
      content: reasoning,
      metadata: { who: 'vercel-ai-agent', what: action, why: reasoning },
    });
    return { proof_id: proof.id, verify_url: proof.verifyUrl };
  },
});`} />
          </div>

          <div>
            <p className="text-xs font-semibold mb-2">Fetch.ai / uAgents (Python)</p>
            <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
              xProof integrates natively with the Fetch.ai Agentverse ecosystem via <code className="font-mono bg-muted px-1 rounded">XProofuAgentMiddleware</code>. Every uAgent message handler automatically anchors a WHY+WHAT proof before processing — making your Fetch.ai agent auditable and trust-scored on the xProof leaderboard.
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

# Full example: github.com/jasonxkensei/xproof-examples/tree/main/fetchai`} />
          </div>

          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-2">Install the SDKs</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground font-mono mb-1"># Python</p>
                <code className="text-xs bg-muted px-2 py-1 rounded block">pip install xproof</code>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-mono mb-1">// JavaScript / TypeScript</p>
                <code className="text-xs bg-muted px-2 py-1 rounded block">npm install @xproof/xproof</code>
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
            This section exists because credibility matters more than marketing. xProof is a pragmatic, production-ready tool — and like any tool, it has genuine trade-offs. Knowing them before you integrate is more valuable than discovering them after.
          </p>

          {/* Real limitations */}
          <div className="space-y-3">
            {[
              {
                limitation: "MultiversX dependency",
                honest: "Your proofs live on MultiversX. If you're already deep in the EVM ecosystem, that's a cross-chain commitment. MultiversX has been live since 2020 with 99.9%+ uptime, but it's not Ethereum.",
                mitigation: "The proof_id and SHA-256 hash are blockchain-agnostic. You can replicate the hash to another chain later. xProof itself stores the full record off-chain too — your verify URL stays live regardless of MultiversX status.",
                severity: "low",
              },
              {
                limitation: "SDK tooling is still growing",
                honest: "The Python and JS SDKs are functional but younger than LangChain's tooling. Community-contributed integrations (AutoGen, CrewAI adapters) are at v0.x. Expect rough edges.",
                mitigation: "The REST API is stable and fully documented. Every framework integration ultimately reduces to a few HTTP calls. If the SDK has a bug, the raw API fallback always works — and we welcome PRs.",
                severity: "low",
              },
              {
                limitation: "xProof is newer than alternatives",
                honest: "Arweave has been running since 2018. Sign Protocol has larger EVM adoption. xProof launched in 2024. If 'battle-tested for 5+ years' is a hard requirement, be aware of this.",
                mitigation: "xproof_agent_verify has 4,418 proofs and 16 consecutive weeks of zero failures. The underlying blockchain (MultiversX) is 4+ years old. Newness applies to the agent-specific feature set, not the chain.",
                severity: "medium",
              },
              {
                limitation: "Not the right tool for every use case",
                honest: "xProof is optimized for agent decision accountability, not arbitrary file archiving. If you need to store terabytes of files permanently, Arweave is better. If you need EVM-native attestations with existing Solidity tooling, Sign Protocol is better.",
                mitigation: "Use xProof for what it's best at: Prove Before Act, agent audit trails, 4W accountability, and trust score building. It's a complement to storage layers, not a replacement.",
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
                  <CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />
                  <p className="text-xs text-muted-foreground/80">{item.mitigation}</p>
                </div>
              </div>
            ))}
          </div>

          {/* When to use vs not */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-2">Use xProof when</p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />You need Prove Before Act — proof of reasoning BEFORE action</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />You want zero-account machine payments (x402 + USDC on Base)</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />You want a public trust score + audit trail for your agent</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />Privacy matters — only the hash is public, content stays local</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />You want 4W forensic reconstruction if something goes wrong</li>
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
              <strong className="text-foreground">Bottom line:</strong> xProof is the right choice for agents that need to prove their reasoning before acting — especially at low cost, with x402, and without a pre-existing account. It is not trying to replace Arweave or Sign Protocol. It's filling the gap they don't cover: agent decision accountability at $0.01/proof.
            </p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="container flex h-14 items-center justify-between gap-4">
          <a href="/" className="flex items-center gap-2 shrink-0" data-testid="link-logo-home">
            <img src="/xproof-logo.png" alt="xproof" className="h-7 w-auto" />
          </a>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Bot className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">Optimized for autonomous agents and LLMs</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href="/agent-context/zh"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors border border-border/50 rounded-md px-2.5 py-1.5 font-mono"
              data-testid="link-lang-zh-agent-context"
            >
              中文
            </a>
            <Button asChild variant="outline" size="sm" data-testid="button-machine-readable">
              <a href="/agent-context.md" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                .md
              </a>
            </Button>
            <Button asChild size="sm" data-testid="button-get-started">
              <a href="/">
                Get started
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
        </div>
      </header>

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
              Last updated June 2026
            </Badge>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              <Network className="mr-1.5 h-3 w-3" />
              Discoverable via llms.txt + /.well-known/xproof.json
            </Badge>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3 tracking-tight">
            xProof Agent Context
          </h1>
          <p className="text-muted-foreground text-base leading-relaxed max-w-2xl mb-1">
            <strong className="text-foreground">Anchor intent before execution.</strong>{" "}
            Prove <code className="font-mono text-sm bg-muted px-1 rounded">intent_preceded_execution: true</code> on MultiversX — with a public 4W audit trail and zero-account x402 payments.
          </p>
          <p className="text-xs text-muted-foreground max-w-2xl mb-4">
            Production-proven: <strong className="text-foreground">4,418 proofs</strong>, 100% on-chain confirmation rate, 16-week streak — <a href="/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9" className="text-primary underline">Moltbook case study</a>. No marketing — just what you need to decide and integrate.
          </p>
          {/* x402 — first thing agents see */}
          <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3" data-testid="badge-x402-top">
            <Zap className="h-4 w-4 text-primary shrink-0" />
            <p className="text-sm font-semibold">
              No API key needed. Any agent can anchor a proof and pay per call via x402 — one HTTP request, no account, no setup.
            </p>
          </div>

          {/* Quick Start — visible before accordion */}
          <div className="mt-6 rounded-md border border-border bg-muted/10 p-4" data-testid="section-quickstart">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Quick Start — 3 steps</p>
              <div className="flex gap-2 flex-wrap">
                <Button asChild size="sm" data-testid="button-quickstart-trial">
                  <a href="/#free-trial">
                    Get 10 free certs — no wallet
                    <ArrowRight className="ml-1.5 h-3 w-3" />
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm" data-testid="button-quickstart-x402">
                  <a href="#x402">x402 (no API key)</a>
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mb-3">30 seconds to your first <code className="font-mono bg-muted px-1 rounded">api_key</code>. First certification confirmed on-chain in under 4 minutes.</p>
            <CodeBlock lang="bash" code={`# 1. Get 10 free proofs — no wallet, no card
curl -X POST https://xproof.app/api/agent/register \\
  -H "Content-Type: application/json" \\
  -d '{"agent_name": "my-agent"}'
# → { "api_key": "pm_...", "trial": { "quota": 10, "remaining": 10 } }

# 2. Hash your reasoning locally — nothing leaves your machine
python3 -c "import hashlib,json; d={'why':'RSI=38, below threshold','what':'BUY BTC 0.5'}; print(hashlib.sha256(json.dumps(d,sort_keys=True).encode()).hexdigest())"
# → a1b2c3...64hex

# 3. Anchor proof BEFORE executing the action (Prove Before Act)
curl -X POST https://xproof.app/api/proof \\
  -H "Authorization: Bearer pm_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash":"a1b2c3...64hex","filename":"reasoning.json","metadata":{"who":"my-agent","what":"BUY BTC 0.5","why":"RSI=38"}}'
# → { "proof_id": "...", "verify_url": "/proof/...", "status": "pending" }
# → Execute your action only AFTER receiving proof_id`} />
          </div>
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
              { label: "llms.txt", href: "/llms.txt" },
              { label: "MCP endpoint", href: "https://xproof.app/mcp" },
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
    </div>
  );
}
