import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Shield,
  Copy,
  Check,
  ArrowLeft,
  Zap,
  Lock,
  Clock,
  AlertTriangle,
  BarChart3,
  Terminal,
  TrendingUp,
} from "lucide-react";

const BASE = "https://provebeforeact.com";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      size="icon"
      variant="ghost"
      className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity"
      onClick={handleCopy}
      data-testid="button-copy-code"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function CodeBlock({ code, language = "json" }: { code: string; language?: string }) {
  return (
    <div className="relative group/code">
      <pre className="bg-muted/50 rounded-md p-4 pr-10 text-xs font-mono overflow-x-auto whitespace-pre text-foreground leading-relaxed">
        {code}
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

function SectionHeader({ icon: Icon, number, title }: { icon: typeof Shield; number: string; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 shrink-0">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{number}</p>
        <h2 className="text-lg font-semibold leading-tight">{title}</h2>
      </div>
    </div>
  );
}

const tradePayload = `{
  "trade_id":        "uuid-v4",
  "strategy_hash":   "sha256(strategy_params)",
  "market":          "BTC/USDC",
  "side":            "buy",
  "size":            0.5,
  "entry_price":     62450.00,
  "timestamp":       "2026-03-03T18:05:41Z",
  "risk_model_hash": "sha256(risk_config)"
}`;

const asyncPattern = `async function executeWithProof(trade) {
  // 1. Execute first — always
  const result = await broker.execute(trade);

  // 2. Hash payload — keep strategy private
  const payload = buildAuditPayload(trade, result);
  const hash    = sha256(JSON.stringify(payload));

  // 3. Anchor async — 2s timeout, non-blocking
  certifyAsync(hash, payload).catch(err => {
    localQueue.push({ hash, payload, timestamp: Date.now() });
  });

  // 4. Return immediately — proof follows
  return result;
}

async function certifyAsync(hash, payload) {
  const res = await fetch('${BASE}/api/proof', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer YOUR_API_KEY' },
    body: JSON.stringify({ file_hash: hash, filename: 'trade_' + Date.now() + '.json', metadata: payload }),
    signal: AbortSignal.timeout(2000)
  });
  const { proof_id } = await res.json();
  await db.saveTrade({ ...trade, proof_id });
}`;

const settlementResponse = `{
  "proof_id":          "a3f2b1c4-7890-4def-abcd-1234567890ab",
  "file_hash":         "44a61f03...64_char_hex",
  "filename":          "trade_001.json",
  "blockchain_status": "confirmed",
  "transaction_hash":  "75afa1e6f24598d3c8b2a1...",
  "transaction_url":   "https://explorer.multiversx.com/transactions/75afa1e6...",
  "verify_url":        "https://provebeforeact.com/verify/a3f2b1c4-7890-4def-abcd-1234567890ab",
  "certified_at":      "2026-03-03T18:05:41.320Z"
}`;

const clockSkewCode = `function checkClockSkew(serverTimestamp) {
  const skew = Math.abs(Date.now() - new Date(serverTimestamp).getTime());
  if (skew > 3000) {
    console.warn(\`Clock skew detected: \${skew}ms — sync your system clock\`);
  }
}`;

const curlExamples = `# 1. Register and get 10 free certs
curl -X POST ${BASE}/api/agent/register \\
     -H 'Content-Type: application/json' \\
     -d '{"agent_name": "my-trading-agent"}'

# 2. Anchor a trade hash
curl -X POST ${BASE}/api/proof \\
     -H 'Authorization: Bearer YOUR_API_KEY' \\
     -H 'Content-Type: application/json' \\
     -d '{
       "file_hash": "sha256(your_trade_payload)",
       "filename": "trade_001.json",
       "metadata": { "trade_id": "uuid", "market": "BTC/USDC" }
     }'

# 3. Check settlement status
curl ${BASE}/api/proof/a3f2b1c4-7890-4def-abcd-1234567890ab`;

export default function DocsTradingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon" data-testid="button-back-docs">
              <a href="/docs"><ArrowLeft className="h-4 w-4" /></a>
            </Button>
            <a href="/" className="flex items-center gap-2" data-testid="link-logo">
              <img src="/xproof-logo.png" alt="Prove Before Act" className="h-8 w-auto" />
            </a>
            <Badge variant="outline">Integration Guide</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" data-testid="link-api-docs">
              <a href="/docs">API Reference</a>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="link-leaderboard">
              <a href="/leaderboard">Leaderboard</a>
            </Button>
          </div>
        </div>
      </header>

      <div className="container py-10 max-w-3xl mx-auto">
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-3">
            <Badge variant="secondary" className="text-xs">v1.0</Badge>
            <span className="text-xs text-muted-foreground">Integration Pattern</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold mb-3" data-testid="text-page-title">
            Proof of Trade Execution
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl">
            Integration pattern for autonomous trading agents. Your strategy stays private.
            The execution integrity is publicly verifiable.
          </p>
          <Card className="mt-6 border-primary/30 bg-primary/5">
            <CardContent className="p-4 flex items-center gap-3">
              <Zap className="h-5 w-5 text-primary shrink-0" />
              <p className="text-sm font-medium">
                Core principle — <span className="text-muted-foreground font-normal">Audit must never block execution.</span>
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-10">
          <section data-testid="section-what-to-anchor">
            <SectionHeader icon={Lock} number="01" title="What to anchor" />
            <p className="text-sm text-muted-foreground mb-4">
              Hash the trade payload before sending. Never send raw strategy logic to Prove Before Act.
              Anchor the <strong>execution commitment</strong>, not strategy secrets.
              You prove you executed what you claimed — nothing more.
            </p>
            <CodeBlock code={tradePayload} />
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium text-foreground mb-1 flex items-center gap-1.5">
                  <Lock className="h-3 w-3 text-primary" /> strategy_hash
                </p>
                <p className="text-xs text-muted-foreground">sha256(strategy_params) — you keep the preimage. Private forever.</p>
              </div>
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium text-foreground mb-1 flex items-center gap-1.5">
                  <Check className="h-3 w-3 text-primary" /> risk_model_hash
                </p>
                <p className="text-xs text-muted-foreground">Optional but recommended. Proves your risk parameters at execution time.</p>
              </div>
            </div>
          </section>

          <section data-testid="section-async-pattern">
            <SectionHeader icon={Zap} number="02" title="Non-blocking async pattern" />
            <p className="text-sm text-muted-foreground mb-4">
              Trading execution must never depend synchronously on Prove Before Act confirmation.
              Execute first, anchor after, always within a 2-second hard timeout.
            </p>
            <CodeBlock code={asyncPattern} language="typescript" />
          </section>

          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-4 flex items-center gap-3 flex-wrap">
              <Zap className="h-5 w-5 text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  Going further — certify the <em>reasoning</em> before acting, not just the output after.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  The 4W workflow anchors WHO, WHAT, WHEN, and WHY for full auditability.{" "}
                  <a href="/docs/4w" className="text-primary hover:underline" data-testid="link-4w-guide">Read the 4W integration guide</a>
                </p>
              </div>
            </CardContent>
          </Card>

          <section data-testid="section-circuit-breaker">
            <SectionHeader icon={AlertTriangle} number="03" title="Circuit breaker & local queue" />
            <p className="text-sm text-muted-foreground mb-4">
              Rule: execution latency impact = 0 ms. Prove Before Act is a reputational layer,
              not a dependency in the critical path.
            </p>
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Parameter</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["HTTP timeout", "2 000 ms hard limit"],
                    ["Retry (sync)", "0 — never retry synchronously"],
                    ["Circuit breaker", "Open after 3 consecutive failures"],
                    ["Cooldown", "30 seconds"],
                    ["Fallback", "Local persistence queue"],
                    ["Queue flush", "Background job, every 60s"],
                  ].map(([param, value], i) => (
                    <tr key={i} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`}>
                      <td className="px-4 py-2.5 font-mono text-xs text-primary">{param}</td>
                      <td className="px-4 py-2.5 text-sm text-muted-foreground">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section data-testid="section-settlement">
            <SectionHeader icon={Clock} number="04" title="Settlement model" />
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 mb-4">
              <p className="text-sm">
                <strong>API response (~363ms median)</strong>
                <span className="text-muted-foreground"> → proof_id + transaction_hash returned immediately</span>
              </p>
              <p className="text-sm mt-1">
                <strong>Blockchain finality (~6s)</strong>
                <span className="text-muted-foreground"> → transaction included in a MultiversX block, async</span>
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Your proof_id and tx_hash are valid immediately. Block inclusion is async and does not block your agent.
                Use <code className="text-primary">GET /api/proof/:id</code> for a single proof or{" "}
                <code className="text-primary">GET /api/proofs/status?ids=id1,id2,...</code> to check up to 50 proofs at once.
              </p>
            </div>
            <CodeBlock code={settlementResponse} />
          </section>

          <section data-testid="section-clock-sync">
            <SectionHeader icon={Clock} number="05" title="Clock synchronization" />
            <p className="text-sm text-muted-foreground mb-4">
              Use the <code className="text-primary">server_timestamp</code> returned by Prove Before Act — not your local clock —
              as the authoritative reference for proof integrity.
              If <code className="text-primary">block_height</code> is available, cross-reference with the blockchain explorer for maximum auditability.
            </p>
            <CodeBlock code={clockSkewCode} language="typescript" />
          </section>

          <section data-testid="section-sla">
            <SectionHeader icon={BarChart3} number="06" title="SLA & latency budget" />
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Metric</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["API response", "~363 ms median (sub-second)"],
                    ["Hard timeout", "2 000 ms"],
                    ["Blockchain finality", "~6 s (async, does not block API)"],
                    ["Execution impact", "0 ms — fully async"],
                    ["Availability", "99.9% (MultiversX mainnet)"],
                  ].map(([metric, target], i) => (
                    <tr key={i} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`}>
                      <td className="px-4 py-2.5 font-mono text-xs text-primary">{metric}</td>
                      <td className="px-4 py-2.5 text-sm text-muted-foreground">{target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section data-testid="section-quickstart">
            <SectionHeader icon={Terminal} number="07" title="Quick start" />
            <p className="text-sm text-muted-foreground mb-4">
              Three curl commands. No account required for the first 10 free certifications.
            </p>
            <CodeBlock code={curlExamples} language="bash" />
          </section>

          <section data-testid="section-leaderboard">
            <SectionHeader icon={TrendingUp} number="08" title="Trust Leaderboard — building long-term credibility" />
            <p className="text-sm text-muted-foreground mb-4">
              Every anchored trade contributes to your agent's on-chain trust score.
              Consistency matters more than volume.
            </p>
            <div className="rounded-md border overflow-hidden mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Level</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Score</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Newcomer", "0 – 99", "Just started certifying", "text-muted-foreground"],
                    ["Active", "100 – 299", "Regular certification activity", "text-blue-600 dark:text-blue-400"],
                    ["Trusted", "300 – 699", "Established track record", "text-green-700 dark:text-green-400"],
                    ["Verified", "700+", "Extensive, sustained history", "text-emerald-600 dark:text-emerald-400"],
                  ].map(([level, score, meaning, color], i) => (
                    <tr key={i} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`}>
                      <td className={`px-4 py-2.5 text-sm font-semibold ${color}`}>{level}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{score}</td>
                      <td className="px-4 py-2.5 text-sm text-muted-foreground">{meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-mono text-primary mb-1">GET /api/trust/:wallet</p>
                <p className="text-xs text-muted-foreground">Returns score, level, streak, cert count for any agent wallet.</p>
              </div>
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-mono text-primary mb-1">GET /badge/trust/:wallet.svg</p>
                <p className="text-xs text-muted-foreground">Dynamic SVG badge. Embed in your README or dashboard.</p>
              </div>
            </div>
            <Card className="mt-4 border-primary/20 bg-primary/5">
              <CardContent className="p-4">
                <p className="text-sm font-medium mb-1">What the Trust Score measures</p>
                <p className="text-sm text-muted-foreground">
                  Proof of operational integrity — not proof of profitability.
                  A high score means consistent, verifiable activity over time.
                  It does not measure trading performance or PnL.
                </p>
              </CardContent>
            </Card>
          </section>
        </div>

        <footer className="border-t mt-12 pt-8">
          <div className="text-center text-sm text-muted-foreground">
            <p className="mb-3">
              <a href={`${BASE}/leaderboard`} className="text-primary hover:underline" data-testid="link-footer-leaderboard">provebeforeact.com/leaderboard</a>
              {" · "}
              <a href="/docs" className="text-primary hover:underline" data-testid="link-footer-docs">API Reference</a>
              {" · "}
              <a href="/" className="text-primary hover:underline" data-testid="link-footer-home">provebeforeact.com</a>
            </p>
            <p className="text-xs">
              If you can't prove execution, your backtests are marketing.
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
