import { useEffect } from "react";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";

const STYLES = `
  .pba-learn-root {
    --paper: hsl(var(--background));
    --paper-strong: hsl(var(--card));
    --ink: hsl(var(--foreground));
    --muted: hsl(var(--muted-foreground));
    --rule: hsl(var(--border));
    --code: hsl(var(--muted));
    --verified: hsl(var(--primary));
    background: var(--paper);
    color: var(--ink);
  }
  .pba-learn-root a:focus-visible {
    outline: 2px solid var(--verified);
    outline-offset: 4px;
  }
  .pba-learn-root .pba-learn-box { background: var(--paper-strong); border-color: #aeb8af; }
  .pba-learn-root .pba-learn-box.proof,
  .pba-learn-root .pba-learn-cta-primary { background: var(--ink); border-color: var(--ink); }
  .pba-learn-root .pba-learn-invariant { background: var(--code); border-left-color: var(--verified); }
  .pba-learn-root .pba-learn-rule,
  .pba-learn-root .pba-learn-credit { border-color: var(--rule); }
  .pba-learn-root {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--font-serif);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .pba-learn-root * { box-sizing: border-box; }

  /* ── Nav ── */
  .pba-learn-nav {
    border-bottom: 1px solid #d8d5cf;
    padding: 0.65rem 2rem;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }
  .pba-learn-nav a { color: var(--ink); text-decoration: none; }
  .pba-learn-nav a:hover { text-decoration: underline; }
  .pba-learn-nav-brand { font-weight: bold; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
  .pba-learn-nav-spacer { flex: 1; }
  .pba-learn-nav-spec { color: #888; }

  /* ── Main: fills available height ── */
  .pba-learn-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    max-width: 680px;
    margin: 0 auto;
    padding: 1.5rem 2rem 1rem;
    width: 100%;
  }

  /* ── Badge ── */
  .pba-learn-badge {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #888;
    margin-bottom: 0.6rem;
  }

  /* ── Title ── */
  .pba-learn-title {
    font-size: clamp(1.5rem, 3.5vw, 2.4rem);
    font-weight: normal;
    line-height: 1.15;
    letter-spacing: -0.02em;
    margin: 0 0 0.5rem;
  }

  /* ── Tagline ── */
  .pba-learn-tagline {
    font-size: 1rem;
    color: #4a4a4a;
    font-style: italic;
    margin: 0 0 1.25rem;
  }

  /* ── Divider ── */
  .pba-learn-rule {
    border: none;
    border-top: 1px solid #d8d5cf;
    margin: 0 0 1.1rem;
  }

  /* ── Problem ── */
  .pba-learn-problem {
    font-size: 0.975rem;
    line-height: 1.6;
    margin: 0 0 1.25rem;
    color: #0f0f0f;
  }
  .pba-learn-problem strong { font-weight: normal; font-style: italic; }

  /* ── Flow ── */
  .pba-learn-flow {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin: 0 0 1.1rem;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0.15rem 0.1rem 0.35rem;
    scrollbar-width: thin;
  }
  .pba-learn-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    flex: 0 0 auto;
  }
  .pba-learn-box {
    border: 1px solid #c0bdb8;
    padding: 0.45rem 0.9rem;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.07em;
    min-width: 78px;
    text-align: center;
    color: #0f0f0f;
    background: white;
  }
  .pba-learn-box.proof {
    background: #0f0f0f;
    color: white;
    border-color: #0f0f0f;
  }
  .pba-learn-lbl {
    font-family: var(--font-mono);
    font-size: 9px;
    color: #aaa;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .pba-learn-arr {
    font-size: 1rem;
    color: #c0bdb8;
    margin: 0 0.3rem;
    padding-bottom: 1rem;
    flex-shrink: 0;
  }

  /* ── Invariant ── */
  .pba-learn-invariant {
    background: #f0ede8;
    border-left: 3px solid #0f0f0f;
    padding: 0.75rem 1rem;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.55;
    margin: 0 0 1.25rem;
    color: #0f0f0f;
    max-width: 100%;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .pba-learn-invariant .dim { color: #888; }

  /* ── CTAs ── */
  .pba-learn-ctas {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin: 0 0 1rem;
  }
  .pba-learn-cta-primary {
    display: inline-block;
    background: #0f0f0f;
    color: white;
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.06em;
    padding: 0.65rem 1.25rem;
    text-decoration: none;
    border: 1px solid #0f0f0f;
    transition: background 0.15s, color 0.15s;
  }
  .pba-learn-cta-primary:hover { background: #333; border-color: #333; }
  .pba-learn-cta-secondary {
    display: inline-block;
    background: transparent;
    color: #0f0f0f;
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.06em;
    padding: 0.65rem 1.25rem;
    text-decoration: none;
    border: 1px solid #c0bdb8;
    transition: border-color 0.15s;
  }
  .pba-learn-cta-secondary:hover { border-color: #0f0f0f; }

  /* ── Footer credit ── */
  .pba-learn-credit {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #bbb;
    text-align: center;
    padding: 0.75rem 0 1rem;
    border-top: 1px solid #ebe9e4;
    flex-shrink: 0;
  }
  .pba-learn-credit a { color: #bbb; text-decoration: none; }
  .pba-learn-credit a:hover { color: #888; }

  @media (max-width: 600px) {
    .pba-learn-main { padding: 1.2rem 1.2rem 0.8rem; justify-content: flex-start; }
    .pba-learn-flow {
      width: 100%;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      gap: 0.35rem;
      overflow: visible;
      margin-left: 0;
      margin-right: 0;
      padding: 0.15rem 0 0.35rem;
    }
    .pba-learn-step { width: 100%; }
    .pba-learn-box { width: 100%; min-width: 0; }
    .pba-learn-arr {
      align-self: center;
      transform: rotate(90deg);
      margin: -0.05rem 0;
      padding-bottom: 0;
      line-height: 1;
    }
    .pba-learn-ctas { flex-direction: column; }
    .pba-learn-cta-primary, .pba-learn-cta-secondary { text-align: center; }
  }
`;

export default function LearnPage() {
  useEffect(() => {
    document.title = "Prove Before Act in 60 Seconds";
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
    const desc = "Prove Before Act in 60 seconds. The problem, the flow, and the invariant — then read the specification or explore xProof, the reference implementation.";
    setMeta("description", desc);
    setOg("og:title", "Prove Before Act in 60 Seconds");
    setOg("og:description", desc);
    setOg("og:url", "https://provebeforeact.com/learn");
    setOg("og:type", "article");
    let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!canonical) { canonical = document.createElement("link"); canonical.rel = "canonical"; document.head.appendChild(canonical); }
    canonical.href = "https://provebeforeact.com/learn";
  }, []);

  return (
    <>
      <style>{STYLES}</style>
      <div className="pba-learn-root paper-page">

        <PublicSiteHeader paper />

        {/* ── Main ── */}
           <main id="main-content" className="pba-learn-main">
          <div className="pba-learn-badge">60-second overview</div>
          <h1 className="pba-learn-title">What did this agent decide,<br />and when did it decide it?</h1>
          <p className="pba-learn-tagline">A design pattern for accountable autonomous agents</p>

          <hr className="pba-learn-rule" />

          <p className="pba-learn-problem">
            Agents act. When something goes wrong, one question follows — and today it is almost always unanswerable.{" "}
            <strong>Logs tell you what the agent says it did. Prove Before Act makes it commit before acting.</strong>
          </p>

          {/* ── Flow ── */}
          <div className="pba-learn-flow" aria-label="Core sequence: Observe, Decide, Prove, Act, Prove">
            <div className="pba-learn-step">
              <div className="pba-learn-box">OBSERVE</div>
              <div className="pba-learn-lbl">input</div>
            </div>
            <div className="pba-learn-arr">→</div>
            <div className="pba-learn-step">
              <div className="pba-learn-box">DECIDE</div>
              <div className="pba-learn-lbl">intent</div>
            </div>
            <div className="pba-learn-arr">→</div>
            <div className="pba-learn-step">
              <div className="pba-learn-box proof">PROVE</div>
              <div className="pba-learn-lbl">anchored</div>
            </div>
            <div className="pba-learn-arr">→</div>
            <div className="pba-learn-step">
              <div className="pba-learn-box">ACT</div>
              <div className="pba-learn-lbl">execute</div>
            </div>
            <div className="pba-learn-arr">→</div>
            <div className="pba-learn-step">
              <div className="pba-learn-box proof">PROVE</div>
              <div className="pba-learn-lbl">outcome</div>
            </div>
          </div>

          {/* ── Invariant ── */}
          <pre className="pba-learn-invariant">
            <span>T(intent_proof) &lt; T(action)</span>{"\n"}
            <span className="dim">if T(intent_proof) ≥ T(action): not evidence — just a record</span>
          </pre>

          {/* ── CTAs ── */}
          <div className="pba-learn-ctas">
            <a href="/standard" className="pba-learn-cta-primary">Read the specification →</a>
            <a href="/" className="pba-learn-cta-secondary">Explore xProof, the reference implementation →</a>
          </div>
        </main>

        <PublicSiteFooter paper />

      </div>
    </>
  );
}
