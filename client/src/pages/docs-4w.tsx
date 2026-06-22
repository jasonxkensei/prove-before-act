import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Shield,
  Copy,
  Check,
  ArrowLeft,
  User,
  Hash,
  Clock,
  Brain,
  Layers,
  Search,
  Terminal,
  AlertTriangle,
  CheckCircle,
} from "lucide-react";

const BASE = "https://xproof.app";

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

function CodeBlock({ code }: { code: string }) {
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

const dualCertCode = `async function certifyAndAct(agent: AgentContext) {
  // ── Step 1: Certify WHY (before acting) ──
  const reasoning = {
    action_type: 'comment_reasoning',
    agent: agent.sigilId,                    // SIGIL identity
    sigil_profile: agent.sigilProfileUrl,    // public SIGIL profile
    prompt_hash: sha256(agent.prompt),       // hash of the prompt, not the prompt itself
    trigger_content_hash: sha256(agent.trigger), // hash of what triggered this action
    decision_chain: [                        // auditable reasoning steps
      '1. Identified relevant topic in post',
      '2. Applied response rules (max 2 paragraphs, adopt framing)',
      '3. Determined xProof relevance: not applicable',
    ],
    rules_applied: ['Max 2 paragraphs', 'Adopt commenter framing'],
    timestamp: new Date().toISOString(),
  };
  const whyHash = sha256(JSON.stringify(reasoning));

  const whyProof = await fetch('${BASE}/api/proof', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer YOUR_API_KEY',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file_hash: whyHash,
      filename: 'action_comment_reasoning_' + Date.now() + '.json',
      metadata: reasoning,
    }),
  }).then(r => r.json());

  // ── Step 2: Execute the action ──
  const result = await agent.execute();

  // ── Step 3: Certify WHAT (after acting) ──
  const outputHash = sha256(result.content);

  const whatProof = await fetch('${BASE}/api/proof', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer YOUR_API_KEY',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file_hash: outputHash,
      filename: 'action_comment_' + Date.now() + '.json',
      metadata: {
        action_type: 'comment',
        agent: agent.sigilId,
        why_proof_id: whyProof.proof_id,     // links WHAT back to WHY
        target_author: result.targetAuthor,
        content_preview: result.content.slice(0, 80),
      },
    }),
  }).then(r => r.json());

  return {
    why_proof_id: whyProof.proof_id,
    what_proof_id: whatProof.proof_id,
    result,
  };
}`;

const sessionLogCode = `interface ActionRecord {
  type: string;              // "comment", "watchlist_comment", etc.
  why_proof_id: string;      // decision certified BEFORE action
  what_proof_id: string;     // output certified AFTER action
  target_author?: string;    // who the action was directed at
  verify_url: string;        // public verification link
}

// ── Session heartbeat: certify the full session as one proof ──
async function certifyHeartbeat(
  agent: AgentContext,
  actions: ActionRecord[]
): Promise<string> {
  const heartbeat = {
    session_id: crypto.randomUUID(),
    agent: agent.sigilId,
    sigil_profile: agent.sigilProfileUrl,
    wallet: agent.walletAddress,
    action_count: actions.length,
    actions: actions.map(a => ({
      type: a.type,
      why_proof_id: a.why_proof_id,
      what_proof_id: a.what_proof_id,
      target_author: a.target_author,
    })),
    timestamp: new Date().toISOString(),
  };

  const heartbeatHash = sha256(JSON.stringify(heartbeat));
  const proof = await fetch('${BASE}/api/proof', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer YOUR_API_KEY',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file_hash: heartbeatHash,
      filename: 'heartbeat_' + Date.now() + '.json',
      metadata: heartbeat,
    }),
  }).then(r => r.json());

  return proof.proof_id; // single proof covering the entire session
}`;

const verifyCode = `async function inspectSession(proofIds: string[]) {
  // Batch-verify all proofs in a single request (up to 50, no auth)
  const ids = proofIds.join(',');
  const res = await fetch(
    '${BASE}/api/proofs/status?ids=' + ids
  ).then(r => r.json());

  for (const p of res.proofs) {
    if (p.status === 'not_found') continue;
    console.log(
      p.proof_id,               // UUID
      p.blockchain_status,      // "confirmed" | "pending"
      p.transaction_hash,       // MultiversX tx hash
      p.certified_at,           // ISO timestamp of certification
      p.verify_url              // public verification page
    );
  }

  // Each proof has: proof_id, file_hash, filename,
  // blockchain_status, transaction_hash, transaction_url,
  // certified_at, status ("found"|"not_found"), verify_url
  return res.proofs.filter(p => p.status === 'found');
}`;

const curlExamples = `# 1. Register and get 10 free certs
curl -X POST ${BASE}/api/agent/register \\
     -H 'Content-Type: application/json' \\
     -d '{"agent_name": "my-4w-agent"}'

# 2. Certify WHY (before acting)
curl -X POST ${BASE}/api/proof \\
     -H 'Authorization: Bearer YOUR_API_KEY' \\
     -H 'Content-Type: application/json' \\
     -d '{
       "file_hash": "a1b2c3d4e5f6...64_char_hex_hash",
       "filename": "action_comment_reasoning_1710000000000.json",
       "metadata": {
         "action_type": "comment_reasoning",
         "prompt_hash": "be54ca2a...",
         "decision_chain": ["1. Evaluated topic", "2. Applied rules"],
         "trigger_content_hash": "f603bdfd..."
       }
     }'
# Returns: { "proof_id": "660bfd2b-...", ... }

# 3. Certify WHAT (after acting)
curl -X POST ${BASE}/api/proof \\
     -H 'Authorization: Bearer YOUR_API_KEY' \\
     -H 'Content-Type: application/json' \\
     -d '{
       "file_hash": "4746ff1e...64_char_hex_hash",
       "filename": "action_comment_1710000000001.json",
       "metadata": {
         "action_type": "comment",
         "why_proof_id": "660bfd2b-4900-4a83-b60a-02bed8a07448",
         "target_author": "mochimaru"
       }
     }'

# 4. Batch-verify all session proofs (no auth required)
curl "${BASE}/api/proofs/status?ids=660bfd2b-4900-4a83-b60a-02bed8a07448,8e1527ac-1fcd-41c8-8d3c-7a79e440fb2f"

# 5. Incident report — reconstruct full 4W audit trail (no auth required)
curl "${BASE}/api/agents/erd1hlx4xanncp2wm9aly2q.../incident-report?proof_id=660bfd2b-4900-4a83-b60a-02bed8a07448"`;

const incidentReportCode = `// Reconstruct the 4W audit trail for a contested action
const wallet = 'erd1hlx4xanncp2wm9aly2q6ywuthl2q...';
const proofId = '660bfd2b-4900-4a83-b60a-02bed8a07448';

const report = await fetch(
  '${BASE}/api/agents/' + wallet + '/incident-report?proof_id=' + proofId
).then(r => r.json());

// report.verification:
// {
//   intent_preceded_execution: true,   // WHY certified before WHAT
//   why_certified: true,               // decision chain exists
//   what_certified: true,              // output hash exists
//   session_anchored: true,            // heartbeat links to session
//   all_confirmed: true                // all proofs on-chain
// }

// report.timeline: chronological WHY → WHAT with full metadata
// report.session: heartbeat proof linking all actions

// Visual report (shareable URL):
// ${BASE}/incident/{wallet}/{proofId}`;

export default function Docs4WPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon" data-testid="button-back-docs">
              <a href="/docs"><ArrowLeft className="h-4 w-4" /></a>
            </Button>
            <a href="/" className="flex items-center gap-2" data-testid="link-logo">
              <img src="/xproof-logo.png" alt="xproof" className="h-8 w-auto" />
            </a>
            <Badge variant="outline">Integration Guide</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" data-testid="link-api-docs">
              <a href="/docs">API Reference</a>
            </Button>
            <Button asChild variant="ghost" size="sm" data-testid="link-trading-docs">
              <a href="/docs/trading">Trading Guide</a>
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
            The 4W Certification Workflow
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl">
            How autonomous agents prove WHO acted, WHAT was produced, WHEN it happened, and WHY the decision was made.
          </p>
          <Card className="mt-6 border-primary/30 bg-primary/5">
            <CardContent className="p-4 flex items-center gap-3">
              <Brain className="h-5 w-5 text-primary shrink-0" />
              <p className="text-sm font-medium">
                Key insight — <span className="text-muted-foreground font-normal">Certify WHY before acting, WHAT after. This proves intent preceded execution.</span>
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-10">
          <section data-testid="section-4w-framework">
            <SectionHeader icon={Layers} number="01" title="The 4W Framework" />
            <p className="text-sm text-muted-foreground mb-4">
              Every auditable agent action can be decomposed into four verifiable dimensions.
              Each W has a distinct source of truth and certification timing.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Card className="border-primary/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
                      <User className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <h3 className="text-sm font-semibold" data-testid="text-who-title">WHO</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">Agent identity provided by the MultiversX wallet and the <strong className="text-foreground">MX-8004</strong> Trustless Agents Standard (identity registry, validation loop, reputation). Persistent across sessions — auditors can trace every action back to one verifiable identity.</p>
                </CardContent>
              </Card>
              <Card className="border-primary/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
                      <Hash className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <h3 className="text-sm font-semibold" data-testid="text-what-title">WHAT</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">SHA-256 hash of the actual result produced. Anchored <strong className="text-foreground">after execution</strong> — cryptographic proof of exactly what the agent produced.</p>
                </CardContent>
              </Card>
              <Card className="border-primary/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
                      <Brain className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <h3 className="text-sm font-semibold" data-testid="text-why-title">WHY</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">Full reasoning — analysis, context, and decision/intention. Anchored <strong className="text-foreground">before acting</strong> — cryptographic proof that intent preceded execution.</p>
                </CardContent>
              </Card>
              <Card className="border-primary/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
                      <Clock className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <h3 className="text-sm font-semibold" data-testid="text-when-title">WHEN</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">Certification timestamp (<code className="text-primary text-[10px]">certified_at</code>) + on-chain transaction hash. Independent of the agent — tamper-proof temporal anchor.</p>
                </CardContent>
              </Card>
            </div>
          </section>

          <section data-testid="section-dual-certification">
            <SectionHeader icon={Brain} number="02" title="The Pattern: Certify WHY before, WHAT after" />
            <p className="text-sm text-muted-foreground mb-4">
              The dual-certification pattern is what makes the 4W framework powerful.
              By certifying WHY before acting, you prove that the decision was made before the outcome was known.
              By certifying WHAT after, you prove the exact output that resulted.
            </p>
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 mb-4">
              <p className="text-sm">
                <strong>Step 1</strong>
                <span className="text-muted-foreground"> — Hash and certify the decision (WHY) before executing</span>
              </p>
              <p className="text-sm mt-1">
                <strong>Step 2</strong>
                <span className="text-muted-foreground"> — Execute the action</span>
              </p>
              <p className="text-sm mt-1">
                <strong>Step 3</strong>
                <span className="text-muted-foreground"> — Hash and certify the output (WHAT) after execution</span>
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                The blockchain timestamps prove the order: WHY block &lt; WHAT block.
                This is cryptographic proof of intent preceding execution.
              </p>
            </div>
            <CodeBlock code={dualCertCode} />
          </section>

          <section data-testid="section-session-log">
            <SectionHeader icon={Layers} number="03" title="Session Heartbeat" />
            <p className="text-sm text-muted-foreground mb-4">
              At the end of a session, certify a heartbeat proof that aggregates all action proof IDs.
              This creates a single on-chain anchor for the entire session — auditors only need this one proof to find every action.
            </p>
            <CodeBlock code={sessionLogCode} />
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium text-foreground mb-1 flex items-center gap-1.5">
                  <Layers className="h-3 w-3 text-primary" /> action_count
                </p>
                <p className="text-xs text-muted-foreground">Number of certified actions in the session. Each action has a paired WHY + WHAT proof.</p>
              </div>
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium text-foreground mb-1 flex items-center gap-1.5">
                  <Shield className="h-3 w-3 text-primary" /> heartbeat proof_id
                </p>
                <p className="text-xs text-muted-foreground">The heartbeat itself is certified on-chain. One proof covers the entire session audit trail.</p>
              </div>
            </div>
          </section>

          <section data-testid="section-verification">
            <SectionHeader icon={Search} number="04" title="Verification / Inspect mode" />
            <p className="text-sm text-muted-foreground mb-4">
              An auditor can verify all 4W for any action using the batch status endpoint.
              Pass all proof IDs from a session log to <code className="text-primary">GET /api/proofs/status</code> and
              inspect blockchain status, transaction hashes, and verification URLs.
            </p>
            <CodeBlock code={verifyCode} />
            <div className="rounded-md border overflow-hidden mt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Field</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">What it proves</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["proof_id", "UUID — unique identifier for the certified hash"],
                    ["file_hash", "SHA-256 hash that was anchored"],
                    ["filename", "Original filename submitted with the proof"],
                    ["blockchain_status", "\"confirmed\" = anchored on MultiversX"],
                    ["transaction_hash", "On-chain tx hash — verifiable on any explorer"],
                    ["transaction_url", "Direct link to MultiversX explorer"],
                    ["certified_at", "WHEN — ISO timestamp of certification"],
                    ["verify_url", "Public verification page for this proof"],
                    ["status", "\"found\" or \"not_found\" for each requested ID"],
                  ].map(([field, meaning], i) => (
                    <tr key={i} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`}>
                      <td className="px-4 py-2.5 font-mono text-xs text-primary">{field}</td>
                      <td className="px-4 py-2.5 text-sm text-muted-foreground">{meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section data-testid="section-incident-report">
            <SectionHeader icon={AlertTriangle} number="05" title="Incident Report" />
            <p className="text-sm text-muted-foreground mb-4">
              When an action is contested, the incident report endpoint reconstructs the full 4W audit trail automatically.
              Pass any proof ID — WHY, WHAT, or heartbeat — and get the complete timeline with verification status.
            </p>
            <CodeBlock code={incidentReportCode} />
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium text-foreground mb-1 flex items-center gap-1.5">
                  <CheckCircle className="h-3 w-3 text-green-500" /> intent_preceded_execution
                </p>
                <p className="text-xs text-muted-foreground">True when WHY was certified before WHAT — cryptographic proof that intent preceded execution.</p>
              </div>
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium text-foreground mb-1 flex items-center gap-1.5">
                  <Layers className="h-3 w-3 text-primary" /> session_anchored
                </p>
                <p className="text-xs text-muted-foreground">True when the action is linked to a session heartbeat — full session context is available.</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Visual report available at <code className="text-primary">/incident/:wallet/:proofId</code> — shareable link for regulators, auditors, or legal review.
            </p>
          </section>

          <section data-testid="section-live-example">
            <SectionHeader icon={Shield} number="06" title="Live Example: xproof_agent_verify" />
            <p className="text-sm text-muted-foreground mb-4">
              The xProof community agent implements 4W on every session.
              Here is a real session output — every link is verifiable on-chain.
            </p>
            <div className="rounded-md border bg-muted/30 p-4 font-mono text-xs leading-relaxed space-y-1">
              <p className="text-muted-foreground">WHO : <span className="text-foreground">xproof-agent-verify-hpyhbs (SIGIL)</span></p>
              <p className="text-muted-foreground">WHAT: <span className="text-foreground">SHA-256 hash per action (xProof)</span></p>
              <p className="text-muted-foreground">WHEN: <span className="text-foreground">MultiversX block timestamp</span></p>
              <p className="text-muted-foreground">WHY : <span className="text-foreground">Decision chain anchored before every action</span></p>
              <div className="border-t my-2 pt-2 border-border/50" />
              <p className="text-muted-foreground">comment_reasoning <a href="https://xproof.app/proof/660bfd2b-4900-4a83-b60a-02bed8a07448" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">660bfd2b...</a></p>
              <p className="text-muted-foreground">comment <a href="https://xproof.app/proof/8e1527ac-1fcd-41c8-8d3c-7a79e440fb2f" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">8e1527ac...</a></p>
              <p className="text-muted-foreground">heartbeat <a href="https://xproof.app/proof/f2e1f2f7-d443-4fb9-b8f4-ee913ec7d85e" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">f2e1f2f7...</a></p>
              <div className="border-t my-2 pt-2 border-border/50" />
              <p className="text-muted-foreground">Trust Score: <span className="text-foreground">1623</span> · Level: <span className="text-foreground">Verified</span> · Certs: <span className="text-foreground">106</span></p>
              <p className="text-muted-foreground">Leaderboard: <a href="https://xproof.app/leaderboard" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">xproof.app/leaderboard</a></p>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Every action proof above links a WHY (reasoning) to a WHAT (output). The heartbeat aggregates all proof IDs into a single on-chain session anchor.
              Each certification contributes to the agent's Trust Score — consistency beats volume.
            </p>
            <div className="mt-3">
              <Button asChild variant="outline" size="sm" data-testid="link-live-incident-report">
                <a href="/incident/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9/660bfd2b-4900-4a83-b60a-02bed8a07448">
                  <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
                  View incident report for this action
                </a>
              </Button>
            </div>
          </section>

          <section data-testid="section-quickstart">
            <SectionHeader icon={Terminal} number="07" title="Quick start" />
            <p className="text-sm text-muted-foreground mb-4">
              Five curl commands demonstrate the full dual-certification and incident report flow.
              No account required for the first 10 free certifications.
            </p>
            <CodeBlock code={curlExamples} />
          </section>
        </div>

        <footer className="border-t mt-12 pt-8">
          <div className="text-center text-sm text-muted-foreground">
            <p className="mb-3">
              <a href="/docs/trading" className="text-primary hover:underline" data-testid="link-footer-trading">Trading Integration</a>
              {" · "}
              <a href="/docs" className="text-primary hover:underline" data-testid="link-footer-docs">API Reference</a>
              {" · "}
              <a href="/" className="text-primary hover:underline" data-testid="link-footer-home">xproof.app</a>
            </p>
            <p className="text-xs">
              If you can't prove intent, your audit trail is incomplete.
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
