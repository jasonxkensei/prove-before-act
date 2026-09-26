import { useState } from "react";
import { ArrowRight, Check, ChevronDown, Copy, ExternalLink, Menu, ShieldCheck, Terminal, X } from "lucide-react";
import "./_premium.css";

const code = `from xproof import certify

proof = certify(
  claim="rebalance portfolio",
  basis="RSI 38 · risk approved",
  actor="treasury-agent"
)
execute(proof.commitment)`;

const faqs = [
  ["Is my source data uploaded?", "No. xProof receives a SHA-256 hash and declared metadata. Your source material stays in the agent's runtime."],
  ["What does Prove Before Act mean?", "It is the accountability pattern: an agent commits a verifiable decision basis before execution, then records the outcome after."],
  ["How does xProof fit in?", "xProof is the reference implementation of the Prove Before Act specification. It anchors public evidence and returns a proof ID."],
  ["Can anyone verify a proof?", "Yes. Every proof has a public verification URL, commitment timestamp, actor, issuer, and resulting outcome."],
];

export function PremiumAccountability() {
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [agent, setAgent] = useState("");
  const [registered, setRegistered] = useState(false);
  const [verified, setVerified] = useState(false);

  const copyCode = async () => {
    await navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <main className="pba-premium" id="top">
      <header className="pba-nav">
        <a href="#top" className="pba-brand"><img src="/__mockup/pba-logo.svg" alt="Prove Before Act" /></a>
        <nav className={menu ? "pba-links pba-links-open" : "pba-links"}>
          <a href="#why" onClick={() => setMenu(false)}>Why PBA</a>
          <a href="#loop" onClick={() => setMenu(false)}>The loop</a>
          <a href="#developers" onClick={() => setMenu(false)}>Developers</a>
          <a href="#pricing" onClick={() => setMenu(false)}>Pricing</a>
          <a href="#faq" onClick={() => setMenu(false)}>FAQ</a>
        </nav>
        <div className="pba-nav-actions">
          <a className="pba-text-link" href="#verify">Verify a proof <ArrowRight size={14} /></a>
          <a className="pba-button pba-button-small" href="#start">Start free <ArrowRight size={14} /></a>
          <button className="pba-menu-button" onClick={() => setMenu(!menu)} aria-label="Toggle navigation">{menu ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </header>

      <section className="pba-hero">
        <div className="pba-hero-copy">
          <div className="pba-kicker"><span className="pba-status-dot" /> PUBLIC ACCOUNTABILITY FOR AUTONOMOUS AGENTS</div>
          <h1>Accountability starts<br /><em>before the action.</em></h1>
          <p className="pba-hero-lede">Prove Before Act is the open accountability pattern for agents that make consequential decisions. Commit the declared decision basis first. Execute second. Leave evidence anyone can verify.</p>
          <div className="pba-actions">
            <a className="pba-button" href="#start">Run your first proof <ArrowRight size={16} /></a>
            <a className="pba-outline-button" href="#loop">See the accountability loop <ArrowRight size={16} /></a>
          </div>
          <div className="pba-hero-note"><span className="pba-mono">T(intent_proof) &lt; T(action)</span><span>·</span><span>xProof is the reference implementation</span></div>
        </div>
        <div className="pba-hero-art">
          <div className="pba-proof-card">
            <div className="pba-proof-head"><span className="pba-label">LIVE EVIDENCE / PRF_7A91</span><span className="pba-verified"><Check size={13} /> VERIFIED</span></div>
            <div className="pba-claim">Rebalance treasury exposure</div>
            <div className="pba-proof-row"><span>Declared decision basis</span><strong>RSI 38 · risk approved</strong></div>
            <div className="pba-proof-row"><span>Commitment timestamp</span><strong className="pba-mono">2025-06-18 14:32:07 UTC</strong></div>
            <div className="pba-proof-row"><span>Actor / issuer</span><strong>treasury-agent <i>·</i> xProof</strong></div>
            <div className="pba-proof-divider" />
            <div className="pba-outcome"><span><span className="pba-outcome-bar" /> OUTCOME RECORDED</span><strong>Action completed · +0.8% USDC</strong></div>
            <button className="pba-verify-link" onClick={() => setVerified(!verified)}>{verified ? "Independent verification complete" : "Open independent verification"} <ExternalLink size={13} /></button>
            {verified && <div className="pba-verification"><ShieldCheck size={15} /> Hash matches commitment on MultiversX</div>}
          </div>
          <div className="pba-art-caption"><span>01</span> The evidence is the product.</div>
        </div>
      </section>

      <section className="pba-thesis" id="why">
        <div className="pba-section-index">01 / THE THESIS</div>
        <div className="pba-thesis-grid">
          <h2>Autonomy without<br /><span>accountability</span> is a blind spot.</h2>
          <div><p>Agents are moving money, changing infrastructure, and speaking for companies. A log of what happened is not enough.</p><p className="pba-muted">Prove Before Act adds a narrow, durable invariant: the agent must publish a commitment to its declared decision basis before the action can happen.</p><a className="pba-arrow-link" href="#developers">Read the PBA standard <ArrowRight size={15} /></a></div>
        </div>
        <div className="pba-equation"><span>OBSERVE</span><b>→</b><span>DECIDE</span><b>→</b><strong>PROVE</strong><b>→</b><span>ACT</span><b>→</b><strong>PROVE</strong></div>
      </section>

      <section className="pba-loop" id="loop">
        <div className="pba-section-index">02 / THE CANONICAL LOOP</div>
        <div className="pba-loop-intro"><h2>A commitment is not<br /><em>a transcript.</em></h2><p>Declare the basis that can be inspected. Keep private cognition private. Make the boundary between intent and action public.</p></div>
        <div className="pba-steps">
          {[["01", "OBSERVE", "Collect the relevant state.", "Signals, files, balances, permissions."], ["02", "DECIDE", "Declare the decision basis.", "A concise, inspectable justification."], ["03", "PROVE", "Anchor the commitment.", "Hash, timestamp, actor, issuer."], ["04", "ACT", "Execute the approved action.", "The commitment travels with the action."], ["05", "PROVE", "Record the outcome.", "Close the loop with what happened."]].map(([num, title, lead, text], i) => <div className={i === 2 ? "pba-step pba-step-active" : "pba-step"} key={num}><span className="pba-step-num">{num}</span><h3>{title}</h3><strong>{lead}</strong><p>{text}</p></div>)}
        </div>
      </section>

      <section className="pba-standard">
        <div className="pba-standard-label">THE PATTERN / THE IMPLEMENTATION</div>
        <div className="pba-standard-grid"><div><h2>Prove Before Act</h2><p>An open pattern for public accountability. The invariant is simple enough to adopt across models, frameworks, and agents.</p></div><div className="pba-standard-connector">→</div><div><h2 className="pba-green-text">xProof</h2><p>The reference implementation. One API call anchors an independently verifiable proof on MultiversX.</p><a href="#developers" className="pba-arrow-link">Explore xProof <ArrowRight size={15} /></a></div></div>
      </section>

      <section className="pba-developers" id="developers">
        <div className="pba-section-index">03 / FOR BUILDERS</div>
        <div className="pba-dev-grid"><div><h2>One proof before<br /><em>the next call.</em></h2><p>Drop xProof into an execution loop without moving source data or rebuilding your stack. Python, TypeScript, curl, or MCP.</p><div className="pba-code-meta"><span><span className="pba-status-dot" /> READY TO INTEGRATE</span><span>~1 second to anchor</span></div></div>
          <div className="pba-code-wrap"><div className="pba-code-top"><span>quickstart.py</span><button onClick={copyCode}>{copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}</button></div><pre><code>{code}</code></pre></div></div>
      </section>

      <section className="pba-usecases"><div className="pba-section-index">04 / WHERE IT LANDS</div><div className="pba-use-grid"><h2>Every action<br />worth <em>explaining.</em></h2><div className="pba-use-list">{[["Trading & treasury", "Risk-approved execution with a public commitment."], ["Research & support", "Sources, model version, and policy basis in the record."], ["CI/CD & orchestration", "A durable handoff between agents, systems, and teams."]].map(([title, desc]) => <div className="pba-use-item" key={title}><span className="pba-mono">0{title === "Trading & treasury" ? 1 : title === "Research & support" ? 2 : 3}</span><div><h3>{title}</h3><p>{desc}</p></div><ArrowRight size={16} /></div>)}</div></div></section>

      <section className="pba-start" id="start"><div className="pba-start-copy"><div className="pba-kicker">START WITH 10 FREE PROOFS</div><h2>Make your next action<br /><em>inspectable.</em></h2><p>Register an agent. Get a <span className="pba-mono">pm_</span> key. Anchor a proof in under two minutes. No wallet or credit card needed.</p></div><div className="pba-register">{!registered ? <><label htmlFor="agent-name">Agent or project name</label><div className="pba-input-row"><input id="agent-name" value={agent} onChange={e => setAgent(e.target.value)} placeholder="e.g. treasury-agent" /><button className="pba-button" disabled={agent.trim().length < 2} onClick={() => setRegistered(true)}>Get my key <ArrowRight size={15} /></button></div><div className="pba-form-notes"><span>10 free proofs</span><span>No wallet</span><span>No credit card</span></div></> : <div className="pba-key-result"><span className="pba-verified"><Check size={14} /> KEY READY</span><code>pm_live_9a7c3f4d8e2b1a6c</code><p>Ready for {agent}. Your first proof is waiting.</p><a href="#developers" className="pba-arrow-link">View the integration guide <ArrowRight size={15} /></a></div>}</div></section>

      <section className="pba-pricing" id="pricing"><div className="pba-section-index">05 / PRICING</div><div className="pba-price-grid"><div><h2>Pay for proof,<br /><em>not permission.</em></h2><p>One transparent rate for public verification. No subscription, no tiers, no lock-in.</p></div><div className="pba-price"><div><span className="pba-price-number">$0.01</span><span className="pba-muted"> / proof</span></div><ul>{["Unlimited proofs", "Public verification URL", "MultiversX timestamp", "Optional PDF + QR export"].map(x => <li key={x}><Check size={15} />{x}</li>)}</ul><a className="pba-button" href="#start">Start free <ArrowRight size={15} /></a></div></div></section>

      <section className="pba-faq" id="faq"><div className="pba-section-index">06 / QUESTIONS</div><div className="pba-faq-grid"><h2>Before you<br /><em>ship it.</em></h2><div>{faqs.map(([q, a], i) => <div className="pba-faq-item" key={q}><button onClick={() => setOpenFaq(openFaq === i ? null : i)}><span>{q}</span><ChevronDown size={17} className={openFaq === i ? "pba-chevron-open" : ""} /></button>{openFaq === i && <p>{a}</p>}</div>)}</div></div></section>

      <section className="pba-final"><div className="pba-kicker">THE BOUNDARY IS THE FEATURE</div><h2>Let agents act.<br /><em>Make it provable.</em></h2><div className="pba-actions"><a className="pba-button" href="#start">Start with xProof <ArrowRight size={16} /></a><a className="pba-outline-button" href="#developers"><Terminal size={15} /> Read the docs</a></div></section>
      <footer className="pba-footer"><img src="/__mockup/pba-logo.svg" alt="Prove Before Act" /><p>The accountability pattern for agents that act in the world.</p><div className="pba-footer-links"><a href="#loop">PBA Standard</a><a href="#developers">API docs</a><a href="#faq">Privacy</a><span>© 2025 Prove Before Act</span></div></footer>
    </main>
  );
}