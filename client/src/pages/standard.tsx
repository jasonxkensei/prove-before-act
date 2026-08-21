import { useEffect } from "react";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";

const STYLES = `
  .pba-std-root {
    background: #f8f7f4;
    color: #0f0f0f;
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 17px;
    line-height: 1.75;
    min-height: 100vh;
  }
  .pba-std-root * { box-sizing: border-box; }

  .pba-std-header {
    border-bottom: 2px solid #0f0f0f;
    padding: 3rem 0 2rem;
    text-align: center;
  }
  .pba-std-meta {
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #888;
    margin-bottom: 1.5rem;
  }
  .pba-std-header h1 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: clamp(1.8rem, 4vw, 3rem);
    font-weight: normal;
    line-height: 1.2;
    letter-spacing: -0.02em;
    max-width: 720px;
    margin: 0 auto 1rem;
  }
  .pba-std-sub {
    font-size: 1rem;
    color: #4a4a4a;
    font-style: italic;
  }
  .pba-std-question {
    margin-top: 1rem;
    font-size: 1rem;
    color: #4a4a4a;
    font-style: italic;
  }
  .pba-std-version {
    margin-top: 1.5rem;
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    color: #888;
    letter-spacing: 0.08em;
  }

  .pba-std-container {
    max-width: 720px;
    margin: 0 auto;
    padding: 0 2rem;
  }

  .pba-std-toc {
    border-top: 1px solid #d8d5cf;
    border-bottom: 1px solid #d8d5cf;
    padding: 2rem 0;
    margin: 3rem 0;
  }
  .pba-std-toc-label {
    font-family: 'Courier New', Courier, monospace;
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #888;
    margin-bottom: 1rem;
  }
  .pba-std-toc ol {
    list-style: none;
    columns: 2;
    column-gap: 2rem;
    padding: 0;
    margin: 0;
  }
  .pba-std-toc li {
    padding: 0.2rem 0;
    font-size: 0.9rem;
  }
  .pba-std-toc a {
    color: #4a4a4a;
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: border-color 0.15s;
  }
  .pba-std-toc a:hover { border-bottom-color: #4a4a4a; }

  .pba-std-section {
    margin-bottom: 4rem;
  }
  .pba-std-section-num {
    font-family: 'Courier New', Courier, monospace;
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #888;
    display: block;
    margin-bottom: 0.5rem;
  }
  .pba-std-root h2 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 1.6rem;
    font-weight: normal;
    letter-spacing: -0.01em;
    line-height: 1.3;
    margin-bottom: 1.5rem;
    padding-top: 3rem;
    border-top: 1px solid #d8d5cf;
    color: #0f0f0f;
  }
  .pba-std-root h3 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 1.1rem;
    font-weight: normal;
    font-style: italic;
    margin: 2rem 0 0.75rem;
    color: #4a4a4a;
  }
  .pba-std-root p { margin-bottom: 1.25rem; }

  .pba-std-flow {
    border: 1px solid #d8d5cf;
    padding: 2.5rem;
    margin: 2.5rem 0;
    background: white;
    text-align: center;
  }
  .pba-std-flow-title {
    font-family: 'Courier New', Courier, monospace;
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #888;
    margin-bottom: 2rem;
  }
  .pba-std-flow-steps {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    flex-wrap: wrap;
  }
  .pba-std-flow-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
  }
  .pba-std-flow-box {
    border: 1px solid #0f0f0f;
    padding: 0.6rem 1.2rem;
    font-family: 'Courier New', Courier, monospace;
    font-size: 12px;
    letter-spacing: 0.05em;
    min-width: 100px;
    text-align: center;
    background: transparent;
    color: #0f0f0f;
  }
  .pba-std-flow-box.proof {
    background: #0f0f0f;
    color: white;
    border-color: #0f0f0f;
  }
  .pba-std-flow-label {
    font-family: 'Courier New', Courier, monospace;
    font-size: 9px;
    color: #888;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .pba-std-flow-arrow {
    font-size: 1.2rem;
    color: #d8d5cf;
    margin: 0 0.5rem;
    padding-bottom: 1.2rem;
  }

  .pba-std-root pre {
    background: #f0ede8;
    border-left: 3px solid #0f0f0f;
    padding: 1.5rem;
    font-family: 'Courier New', Courier, monospace;
    font-size: 13px;
    line-height: 1.6;
    overflow-x: auto;
    margin: 1.5rem 0;
    color: #0f0f0f;
  }
  .pba-std-root code {
    font-family: 'Courier New', Courier, monospace;
    font-size: 0.875em;
    background: #f0ede8;
    padding: 0.1em 0.3em;
    color: #0f0f0f;
  }
  .pba-std-root pre code {
    background: none;
    padding: 0;
    font-size: inherit;
  }

  .pba-std-callout {
    border: 1px solid #d8d5cf;
    border-left: 4px solid #0f0f0f;
    padding: 1.25rem 1.5rem;
    margin: 2rem 0;
    background: white;
  }
  .pba-std-callout p:last-child { margin-bottom: 0; }

  .pba-std-root table {
    width: 100%;
    border-collapse: collapse;
    margin: 1.5rem 0;
    font-size: 0.9rem;
    color: #0f0f0f;
  }
  .pba-std-root th {
    text-align: left;
    font-family: 'Courier New', Courier, monospace;
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #888;
    border-bottom: 2px solid #0f0f0f;
    padding: 0.5rem 1rem 0.5rem 0;
  }
  .pba-std-root td {
    border-bottom: 1px solid #d8d5cf;
    padding: 0.75rem 1rem 0.75rem 0;
    vertical-align: top;
    color: #0f0f0f;
  }
  .pba-std-root td:first-child {
    font-family: 'Courier New', Courier, monospace;
    font-size: 13px;
  }

  .pba-std-checklist {
    list-style: none;
    margin: 1rem 0 1.5rem;
    padding: 0;
  }
  .pba-std-checklist li {
    padding: 0.3rem 0 0.3rem 1.5rem;
    position: relative;
  }
  .pba-std-checklist li::before {
    content: "✓";
    position: absolute;
    left: 0;
    color: #1a6b3c;
    font-family: 'Courier New', Courier, monospace;
  }
  .pba-std-checklist li.no::before {
    content: "✗";
    color: #8b1a1a;
  }

  .pba-std-impl-badge {
    display: inline-block;
    border: 1px solid #0f0f0f;
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    letter-spacing: 0.05em;
    padding: 0.4rem 0.8rem;
    margin-top: 0.5rem;
    text-decoration: none;
    color: #0f0f0f;
    transition: background 0.15s, color 0.15s;
  }
  .pba-std-impl-badge:hover {
    background: #0f0f0f;
    color: white;
  }

  .pba-std-footer {
    border-top: 2px solid #0f0f0f;
    padding: 3rem 0;
    margin-top: 4rem;
    text-align: center;
    background: #f8f7f4;
    color: #0f0f0f;
  }
  .pba-std-footer-logo {
    font-family: 'Courier New', Courier, monospace;
    font-size: 13px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 0.5rem;
  }
  .pba-std-footer-sub {
    font-size: 0.85rem;
    color: #888;
  }
  .pba-std-root a { color: #0f0f0f; }

  @media (max-width: 600px) {
    .pba-std-toc ol { columns: 1; }
    .pba-std-flow-steps { flex-direction: column; gap: 0.5rem; }
    .pba-std-flow-arrow { transform: rotate(90deg); }
    .pba-std-root h2 { font-size: 1.4rem; }
  }
`;

export default function StandardPage() {
  useEffect(() => {
    document.title = "Prove Before Act — A Design Pattern for Accountable Autonomous Agents";
    const setMeta = (name: string, content: string) => {
      let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
      if (!el) { el = document.createElement("meta"); el.name = name; document.head.appendChild(el); }
      el.content = content;
    };
    const setOg = (property: string, content: string) => {
      let el = document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement | null;
      if (!el) { el = document.createElement("meta"); el.setAttribute("property", property); document.head.appendChild(el); }
      el.content = content;
    };
    const desc = "The Prove Before Act specification: a design pattern for accountable autonomous agents. Definitions, threat model, primitives, 4W schema, and reference implementation.";
    setMeta("description", desc);
    setOg("og:title", "Prove Before Act — Technical Specification");
    setOg("og:description", desc);
    setOg("og:url", "https://provebeforeact.com/standard");
    setOg("og:type", "article");
    let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!canonical) { canonical = document.createElement("link"); canonical.rel = "canonical"; document.head.appendChild(canonical); }
    canonical.href = "https://provebeforeact.com/standard";
  }, []);

  return (
    <>
      <style>{STYLES}</style>
      <div className="pba-std-root">
        <PublicSiteHeader paper />
        {/* ── Header ── */}
        <div className="pba-std-header">
          <div className="pba-std-container">
            <div className="pba-std-meta">Technical Specification · Draft v0.1 · August 2026 · Status: Draft</div>
            <h1>Prove Before Act</h1>
            <p className="pba-std-sub">A design pattern for accountable autonomous agents</p>
            <p className="pba-std-question"><em>What did this agent decide, and when did it decide it?</em></p>
            <div className="pba-std-version">provebeforeact.com/standard · Reference implementation: xProof</div>
          </div>
        </div>

        <div className="pba-std-container">
          {/* ── TOC ── */}
          <div className="pba-std-toc">
            <div className="pba-std-toc-label">Contents</div>
            <ol>
              <li><a href="#problem">1. The Problem</a></li>
              <li><a href="#definitions">2. Definitions</a></li>
              <li><a href="#threat-model">3. Threat Model</a></li>
              <li><a href="#why-logs">4. Why Logs Are Not Evidence</a></li>
              <li><a href="#pattern">5. The Pattern</a></li>
              <li><a href="#primitives">6. The Four Primitives</a></li>
              <li><a href="#4w">7. The 4W Audit Trail</a></li>
              <li><a href="#agent-to-agent">8. Agent-to-Agent Accountability</a></li>
              <li><a href="#architectures">9. Example Architectures</a></li>
              <li><a href="#implementation">10. Implementation Requirements</a></li>
              <li><a href="#reference">11. Reference Implementation</a></li>
              <li><a href="#contribute">12. Contribute</a></li>
            </ol>
          </div>

          {/* ── 01 Problem ── */}
          <section id="problem" className="pba-std-section">
            <h2><span className="pba-std-section-num">01</span>The Problem</h2>
            <p>Autonomous agents act. They read data, form decisions, and execute actions — sometimes with real consequences: financial transactions, code deployments, contract signings, infrastructure changes, data modifications.</p>
            <p>When something goes wrong, a single question follows: <em>what did the agent decide, and when did it decide it?</em></p>
            <p>Today, that question is almost always unanswerable.</p>
            <div className="pba-std-callout">
              <p>Logs exist. Every agent running today produces them. But a log is written by the same system that made the decision. An agent that failed silently can reconstruct a clean record. An agent that hallucinated can describe its decision basis in retrospect. There is no technical difference between a real log and a fabricated one.</p>
            </div>
            <p>The log is not a witness. The log is the defendant.</p>
            <p>Prove Before Act addresses this gap. Not by making agents smarter or safer — but by requiring them to commit to their intended action and decision basis before acting, in a way that cannot be altered after the fact.</p>
          </section>

          {/* ── 02 Definitions ── */}
          <section id="definitions" className="pba-std-section">
            <h2><span className="pba-std-section-num">02</span>Definitions</h2>
            <table>
              <thead>
                <tr><th>Term</th><th>Definition</th></tr>
              </thead>
              <tbody>
                <tr><td>Agent</td><td>Any autonomous software system that observes input, forms a decision, and executes an action without continuous human approval.</td></tr>
                <tr><td>Intent</td><td>The decision an agent commits to before acting: what it will do, why, and under what conditions.</td></tr>
                <tr><td>Proof</td><td>A cryptographic commitment (SHA-256 hash) anchored on an external, immutable ledger at a specific timestamp. The proof cannot be altered after anchoring.</td></tr>
                <tr><td>Anchor</td><td>The act of writing a proof to a ledger. The timestamp is written by the ledger, not by the agent.</td></tr>
                <tr><td>Evidence</td><td>A proof whose timestamp precedes the action it describes. Evidence proves intent existed before execution.</td></tr>
                <tr><td>Log</td><td>A record written by the agent after or during execution. Logs are auditable but not independently verifiable.</td></tr>
                <tr><td>Accountability</td><td>The capacity of a system to produce independently verifiable evidence of its decisions.</td></tr>
              </tbody>
            </table>
          </section>

          {/* ── 03 Threat Model ── */}
          <section id="threat-model" className="pba-std-section">
            <h2><span className="pba-std-section-num">03</span>Threat Model</h2>
            <p>Prove Before Act addresses a specific class of failure. It does not address adversarial attacks, model jailbreaks, or infrastructure compromise. It addresses the accountability gap.</p>
            <h3>What Prove Before Act protects against</h3>
            <ul className="pba-std-checklist">
              <li>Post-hoc rationalization — an agent describing decisions it did not make before acting</li>
              <li>Silent failure — an agent that acted incorrectly with no externally verifiable record of intent</li>
              <li>Dispute without evidence — a counterparty claiming the agent acted outside its instructions, with no way to verify</li>
              <li>Regulatory non-compliance — an audit requiring proof of decision provenance the agent cannot produce</li>
              <li>Agent identity drift — a system that changed its model or configuration between commitment and action</li>
            </ul>
            <h3>What Prove Before Act does not protect against</h3>
            <ul className="pba-std-checklist">
              <li className="no">A malicious agent that anchors false intent before acting</li>
              <li className="no">Compromise of the anchoring infrastructure itself</li>
              <li className="no">Incorrect decisions that were correctly proven before acting</li>
            </ul>
            <p>The pattern proves temporal sequence and commitment, not correctness or safety.</p>
          </section>

          {/* ── 04 Why Logs ── */}
          <section id="why-logs" className="pba-std-section">
            <h2><span className="pba-std-section-num">04</span>Why Logs Are Not Evidence</h2>
            <p>The distinction between a log and evidence is temporal and architectural.</p>
            <table>
              <thead>
                <tr><th>Property</th><th>Log</th><th>Proof (Prove Before Act)</th></tr>
              </thead>
              <tbody>
                <tr><td>Written by</td><td>The agent itself</td><td>External ledger</td></tr>
                <tr><td>Timestamp from</td><td>Agent's clock</td><td>Independent consensus</td></tr>
                <tr><td>When created</td><td>During or after execution</td><td>Before execution</td></tr>
                <tr><td>Alterable</td><td>Often yes</td><td>No</td></tr>
                <tr><td>Independently verifiable</td><td>No</td><td>Yes</td></tr>
                <tr><td>Proves intent preceded action</td><td>No</td><td>Yes</td></tr>
              </tbody>
            </table>
            <div className="pba-std-callout">
              <p>A reconstructed audit trail — however detailed — answers the question "what does the agent say it did?" Prove Before Act answers a different question: "what did the agent commit to before acting, as witnessed by a system it cannot control?"</p>
            </div>
          </section>

          {/* ── 05 Pattern ── */}
          <section id="pattern" className="pba-std-section">
            <h2><span className="pba-std-section-num">05</span>The Pattern</h2>
            <p>Prove Before Act is a commit-before-execute sequence. The agent must anchor a cryptographic proof of its intended action before that action executes. The proof timestamp is written by an external ledger.</p>

            <div className="pba-std-flow">
              <div className="pba-std-flow-title">Prove Before Act — Core Sequence</div>
              <div className="pba-std-flow-steps">
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box">OBSERVE</div>
                  <div className="pba-std-flow-label">Input</div>
                </div>
                <div className="pba-std-flow-arrow">→</div>
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box">DECIDE</div>
                  <div className="pba-std-flow-label">Intent formed</div>
                </div>
                <div className="pba-std-flow-arrow">→</div>
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box proof">PROVE</div>
                  <div className="pba-std-flow-label">Anchored on-chain</div>
                </div>
                <div className="pba-std-flow-arrow">→</div>
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box">ACT</div>
                  <div className="pba-std-flow-label">Execution</div>
                </div>
                <div className="pba-std-flow-arrow">→</div>
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box proof">PROVE</div>
                  <div className="pba-std-flow-label">Outcome anchored</div>
                </div>
              </div>
            </div>

            <p>The second PROVE (outcome) is optional but recommended. Together, they produce a complete chain: intent before action, outcome after — both independently verifiable, linked by a <code>link()</code> call.</p>

            <h3>The Core Invariant</h3>
            <div className="pba-std-callout">
              <p>For any Prove Before Act implementation, an intent proof MUST be independently timestamped before the action it describes begins.</p>
            </div>
            <pre>{`T(intent_proof) < T(action)

If T(intent_proof) ≥ T(action):
  → the proof is not evidence of pre-action intent
  → it is a record, not a commitment`}</pre>
            <p>This is what makes the proof evidence rather than a record. A hash anchored after execution proves the content existed — it does not prove the intent preceded the action. The timestamp must be written by the anchoring ledger, not by the agent or its operator. This is also why the WHEN in the 4W schema is always <code>null</code> in the agent's payload — the ledger writes it.</p>
          </section>

          {/* ── 06 Primitives ── */}
          <section id="primitives" className="pba-std-section">
            <h2><span className="pba-std-section-num">06</span>The Four Primitives</h2>
            <p>Any implementation of Prove Before Act requires exactly four operations. These are pattern-level — they are not specific to any anchoring ledger or implementation.</p>
            <div className="pba-std-callout">
              <p><strong>Prove Before Act is ledger-agnostic.</strong> An implementation may use a public blockchain, transparency log, timestamping authority, or any independently verifiable anchoring system — provided the requirements of this specification are satisfied.</p>
            </div>

            <h3>anchor(content) → proof_id</h3>
            <p>Compute a SHA-256 hash of the content locally. Write the hash to an external ledger. Return a proof_id with an immutable timestamp. Raw content never leaves the agent's environment.</p>

            <h3>verify(proof_id) → {"{timestamp, hash, status}"}</h3>
            <p>Given a proof_id, return the anchored hash, the ledger timestamp, and confirmation status. Anyone can call verify — no account required.</p>

            <h3>compare(proof_id_A, proof_id_B) → {"{A_precedes_B: bool}"}</h3>
            <p>Given two proof_ids, determine whether the first proof was anchored before the second. This is the core evidence operation: it answers whether intent preceded action.</p>

            <h3>link(intent_proof_id, outcome_proof_id) → chain_id</h3>
            <p>Explicitly associates an intent proof with its outcome proof, establishing the full WHY→WHAT chain. Required for audit graphs, delegation trees, and agent trust registries. Without this primitive, intent and outcome remain disconnected records rather than a verifiable chain.</p>

            <pre>{`// Minimal implementation contract
interface ProveBeforeAct {
  anchor(content: string | Buffer, metadata?: object): Promise<{
    proof_id: string;
    hash: string;
    timestamp: number;         // written by ledger
    verify_url: string;
  }>;

  verify(proof_id: string): Promise<{
    hash: string;
    timestamp: number;
    status: 'confirmed' | 'pending' | 'not_found';
  }>;

  compare(intent_proof_id: string, action_proof_id: string): Promise<{
    intent_preceded_action: boolean;
    delta_ms: number;
  }>;

  link(intent_proof_id: string, outcome_proof_id: string): Promise<{
    chain_id: string;
    intent_preceded_action: boolean;
  }>;
}`}</pre>
          </section>

          {/* ── 07 4W ── */}
          <section id="4w" className="pba-std-section">
            <h2><span className="pba-std-section-num">07</span>The 4W Audit Trail</h2>
            <p>For an intent proof to be useful, it must answer four questions independently.</p>
            <table>
              <thead>
                <tr><th>W</th><th>Question</th><th>What to anchor</th></tr>
              </thead>
              <tbody>
                <tr><td>WHO</td><td>Which agent made this decision?</td><td>Agent identifier, version, model hash</td></tr>
                <tr><td>WHY</td><td>What was the decision basis?</td><td>Decision rationale, trigger, context hash</td></tr>
                <tr><td>WHAT</td><td>What action was decided?</td><td>Action description, parameters, target</td></tr>
                <tr><td>WHEN</td><td>When was the decision made?</td><td>Ledger timestamp (external, not agent clock)</td></tr>
              </tbody>
            </table>
            <h3>Minimal 4W JSON schema</h3>
            <pre>{`{
  "who": "agent-id-v2.3.1",
  "why": "RSI below 30 threshold, risk/reward 1:3, within position limits",
  // decision basis, not internal chain-of-thought
  "what": "BUY BTC 0.5 at market",
  "when": null  // set by ledger, not by agent
}`}</pre>
            <p>The WHEN field is intentionally <code>null</code> in the agent's payload. Writing a timestamp here would allow post-hoc fabrication. The ledger timestamp is the only authoritative WHEN.</p>
          </section>

          {/* ── 08 Agent-to-Agent ── */}
          <section id="agent-to-agent" className="pba-std-section">
            <h2><span className="pba-std-section-num">08</span>Agent-to-Agent Accountability</h2>
            <p>When Agent A delegates to Agent B, the Prove Before Act pattern extends to the delegation itself. Each boundary in a multi-agent system requires its own proof.</p>

            <div className="pba-std-flow">
              <div className="pba-std-flow-title">Delegation Chain</div>
              <div className="pba-std-flow-steps">
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box">HUMAN</div>
                  <div className="pba-std-flow-label">Principal</div>
                </div>
                <div className="pba-std-flow-arrow">→</div>
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box">AGENT A</div>
                  <div className="pba-std-flow-label">Operator</div>
                </div>
                <div className="pba-std-flow-arrow">→</div>
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box proof">PROVE</div>
                  <div className="pba-std-flow-label">Delegation proof</div>
                </div>
                <div className="pba-std-flow-arrow">→</div>
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box">AGENT B</div>
                  <div className="pba-std-flow-label">Executor</div>
                </div>
                <div className="pba-std-flow-arrow">→</div>
                <div className="pba-std-flow-step">
                  <div className="pba-std-flow-box proof">PROVE</div>
                  <div className="pba-std-flow-label">Execution proof</div>
                </div>
              </div>
            </div>

            <p>The delegation proof establishes that Agent A authorized Agent B before B acted. The execution proof establishes what B did. Together — linked via <code>link()</code> — they produce a verifiable chain of custody across agents.</p>
            <p>In deeper hierarchies (Human → A → B → C), each delegation boundary requires its own proof. Accountability does not dissolve across boundaries; it is enforced at each one. This is the foundation of machine-to-machine accountability.</p>
          </section>

          {/* ── 09 Architectures ── */}
          <section id="architectures" className="pba-std-section">
            <h2><span className="pba-std-section-num">09</span>Example Architectures</h2>

            <h3>Financial agent</h3>
            <pre>{`signal = observe_market()
decision = agent.decide(signal)

# Prove Before Act
intent_proof = anchor({
  who: agent.id,
  why: decision.rationale,   # decision basis, not internal chain-of-thought
  what: f"BUY {decision.asset} {decision.amount}",
  when: null                 # ledger writes this
})

# Only execute after proof confirmed
if intent_proof.status == "confirmed":
    result = execute_trade(decision, proof_id=intent_proof.id)
    outcome_proof = anchor({ what: result.summary, when: null })
    link(intent_proof.id, outcome_proof.id)`}</pre>

            <h3>DevOps agent</h3>
            <pre>{`pr = observe_pull_request()
analysis = agent.analyze(pr)

intent_proof = anchor({
  who: "deploy-agent-v1",
  why: analysis.rationale,
  what: f"DEPLOY to production: {pr.id}",
  when: null
})

if intent_proof.status == "confirmed":
    deploy(pr, proof_id=intent_proof.id)`}</pre>

            <h3>MCP integration <span style={{ fontFamily: "'Courier New', monospace", fontSize: "0.75em", color: "#888", fontStyle: "normal" }}>(xProof reference implementation)</span></h3>
            <pre>{`// xProof maps anchor() → certify_file MCP tool
{
  "name": "certify_file",
  "arguments": {
    "file_hash": "sha256_of_intent_json",
    "filename": "intent.json",
    "metadata": {
      "who": "my-agent-v2",
      "what": "execute trade BUY BTC 0.5",
      "why": "RSI=38, below oversold threshold",  // decision basis
      "purpose": "prove_before_act"
    }
  }
}
// Returns { proof_id, verify_url, status: "anchored" }
// → Execute only after status confirmed
// → Use coherence/link to bind intent_proof to outcome_proof`}</pre>
          </section>

          {/* ── 10 Implementation ── */}
          <section id="implementation" className="pba-std-section">
            <h2><span className="pba-std-section-num">10</span>Implementation Requirements</h2>
            <p>Any implementation claiming Prove Before Act compliance must satisfy the following.</p>
            <ul className="pba-std-checklist">
              <li>Hash computed locally — raw content never sent to anchoring service</li>
              <li>Timestamp written by ledger consensus, not by agent or server clock</li>
              <li>Proof_id publicly verifiable without account or authentication</li>
              <li>compare() returns intent_preceded_action as a boolean derived from ledger timestamps</li>
              <li>link() associates intent and outcome proofs in a queryable, immutable chain</li>
              <li>Proof is immutable after anchoring — no edit, delete, or update operations</li>
              <li>Anchoring ledger is independent of the agent operator</li>
            </ul>
            <h3>Optional but recommended</h3>
            <ul className="pba-std-checklist">
              <li>x402 payment support for fully autonomous agent operation without API keys</li>
              <li>4W metadata schema anchored with each proof</li>
              <li>Outcome proof anchored after execution, linked to intent proof via link()</li>
              <li>Agent identity anchored via a persistent wallet or DID</li>
            </ul>
          </section>

          {/* ── 11 Reference Implementation ── */}
          <section id="reference" className="pba-std-section">
            <h2><span className="pba-std-section-num">11</span>Reference Implementation</h2>
            <p>xProof is the reference implementation of Prove Before Act. It satisfies all requirements in section 10 using MultiversX as the anchoring ledger and supports x402 for fully autonomous operation.</p>
            <table>
              <thead>
                <tr><th>Property</th><th>xProof</th></tr>
              </thead>
              <tbody>
                <tr><td>Anchoring ledger</td><td>MultiversX mainnet</td></tr>
                <tr><td>Hash algorithm</td><td>SHA-256</td></tr>
                <tr><td>Payment</td><td>x402 / USDC on Base ($0.01/proof)</td></tr>
                <tr><td>Free trial</td><td>10 proofs, no wallet or account required</td></tr>
                <tr><td>MCP integration</td><td>Native MCP server at provebeforeact.com/mcp</td></tr>
                <tr><td>Python SDK</td><td>pip install xproof</td></tr>
                <tr><td>Node SDK</td><td>npm install @xproof/xproof</td></tr>
                <tr><td>OpenClaw / Hermes</td><td>openclaw skills install xproof</td></tr>
              </tbody>
            </table>
            <a href="https://provebeforeact.com" className="pba-std-impl-badge">provebeforeact.com →</a>
          </section>

          {/* ── 12 Contribute ── */}
          <section id="contribute" className="pba-std-section">
            <h2><span className="pba-std-section-num">12</span>Contribute</h2>
            <p>Prove Before Act is an open pattern. It is ledger-agnostic. Any implementation that satisfies the requirements in section 10 is a valid Prove Before Act implementation, regardless of anchoring ledger, payment mechanism, or tooling.</p>
            <p>If you have implemented the pattern on a different ledger, built a third-party integration, or identified a gap in this specification — contributions are welcome.</p>
            <div className="pba-std-callout">
              <p>The goal is not for xProof to be the only implementation. The goal is for <em>Prove Before Act</em> to become the vocabulary developers reach for when they need to answer: <strong>what did this agent decide, and when did it decide it?</strong></p>
              <p style={{ marginTop: "1rem", marginBottom: 0 }}>The day someone writes in their README <em>"This agent implements the Prove Before Act pattern"</em> without using xProof, the category will have arrived.</p>
            </div>
            <p>Contact: <a href="https://provebeforeact.com">provebeforeact.com</a> · <a href="https://x.com/ProveBeforeAct">@ProveBeforeAct</a> · <a href="https://www.malt.fr/profile/jasonpetitfourg">Malt</a></p>
          </section>
        </div>

        <PublicSiteFooter paper />
      </div>
    </>
  );
}
