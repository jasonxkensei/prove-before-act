# Published — Prove Before Act SKILL.md

---

## v3.3.8 — 2026-08-19

**Target repo:** https://github.com/jasonxkensei/xproof-openclaw-skill  
**Branch:** main

| Item | Value |
|---|---|
| SKILL.md blob SHA (live) | `5779a9325c9790d80bbc0f93624cd48b3022f252` |
| SKILL.md commit | `c39908fe9d153242a440421e5be11e50faa042b2` |
| Archive `xproof/SKILL-v3.3.8.md` commit | `8b436f11fb2a5d1c5134e16f9516babeb8a0de1f` |
| `references/api-reference.md` commit | `056a72c399b61ea7a25de136d307ec4e8752df9b` |
| `references/certification.md` commit | `7e881dfba4b9517843160024fa5f264f57a11c07` |
| `references/mcp.md` commit | `15e1ef9ca4677bc79d64522d9c5b593a8244aa09` |
| `references/x402.md` commit | `8206c9a6a4c4a50c7ae3d6054589122f14f6d91b` |
| Live URL | https://github.com/jasonxkensei/xproof-openclaw-skill/blob/main/xproof/SKILL.md |

### Changes in v3.3.8

- **Rebrand** — Prove Before Act is the current product name throughout; `xproof`, `XProofClient`, `XPROOF_*`, `xProof-Action`, and `jasonxkensei/xProof` are explicitly labeled legacy compatibility identifiers
- **MX-8004 status-gated** — WHO/identity wording now says MX-8004 is optional and only applies when `GET /api/mx8004/status` reports `active`; production currently reports `not_configured`
- **Removed stale guarantees** — fixed trust-score penalties (-150/-500), "no proof = no execution" enforcement claims, and historical benchmark numbers replaced with deployment-defined / live-endpoint wording
- **Data & Privacy section restored** — transparency table updated for provebeforeact.com
- **Coherence Loop retained** — v3.3.0 pending content (loop, error table, score formula, SDK helpers, cheatsheet) is now live as part of this publish
- Also republished all four reference manuals (`api-reference`, `certification`, `mcp`, `x402`) with current-brand and MX-8004 status notices

---

## v3.3.0 — 2026-07-30 (superseded by v3.3.8 before live publish)

**Target repo:** https://github.com/jasonxkensei/xproof-openclaw-skill  
**Branch:** main

| Item | Value |
|---|---|
| SKILL.md SHA (live) | _not yet published — `GITHUB_PERSONAL_ACCESS_TOKEN` returned 401 Bad credentials on 2026-07-30; retry after refreshing the token_ |

### Changes in v3.3.0

- **New "Coherence Loop" section** — documents the full WHY→WHAT loop: `check_coherence` → act → `certify_file` with `metadata.why_proof_id` → `POST /api/coherence/link`
- **Error cases table** — `409 ALREADY_LINKED`, `400 NOT_A_COHERENCE_ANCHOR`, `404` ownership cases; idempotent re-link behavior
- **Score formula** — 50 link + 15 within-1h + 20 references-why + 15 on-chain; base halved when execution preceded intent
- **SDK helpers referenced** — Python `link_coherence` (Prove Before Act ≥ 0.2.10), npm `linkCoherence` (@prove-before-act/sdk ≥ 0.1.11)
- **Cheatsheet** — added the link curl command

---

## v3.2.0 — 2026-06-22

**Target repo:** https://github.com/jasonxkensei/xproof-openclaw-skill  
**Branch:** main

| Item | Value |
|---|---|
| SKILL.md SHA (live) | `6719a60b1d8ee9e820722e4ae58a07d09acb536b` |
| Live URL | https://github.com/jasonxkensei/xproof-openclaw-skill/blob/main/xproof/SKILL.md |

### Changes in v3.2.0

- **Pricing corrected** — tiered structure ($0.05/$0.025/$0.015) replaced with flat **$0.01/proof** + cost table
- **Prove Before Act** — added as headline concept with canonical wording: *"Anchor reasoning (WHY) + planned decision/intention (WHAT) on-chain before execution. Anchor actual result/output after for a full 4W audit trail."*
- **x402 warning** — fixed `$0.05 each` → `$0.01 each`, batch cap corrected 50 → 100 items
- **Frontmatter description** — rewritten to lead with Prove Before Act and $0.01 flat
- **Version** bumped 3.1.0 → 3.2.0

---

## v3.1.0 — 2026-06-13 (archived as `xproof/SKILL-v3.1.0.md`)

**Date:** 2026-06-13T00:00:00Z  
**Target repo:** https://github.com/jasonxkensei/xproof-openclaw-skill  
**Branch:** main (archived as `xproof/SKILL-v3.1.0.md`)

## Verification

| Item | Value |
|---|---|
| Commit SHA (SKILL.md update) | `e665a34a769bb154e40f80170f4e1b390e9597fd` |
| Commit SHA (archive) | `8b9f250318dacef5b702e6ba71f5887d76e57392` |
| Commit URL | https://github.com/jasonxkensei/xproof-openclaw-skill/commit/e665a34a769bb154e40f80170f4e1b390e9597fd |
| SKILL-v3.1.0.md blob SHA | `8b9f250318dacef5b702e6ba71f5887d76e57392` |
| Archived raw URL | https://raw.githubusercontent.com/jasonxkensei/xproof-openclaw-skill/main/xproof/SKILL-v3.1.0.md |

## Files pushed

| Local path | GitHub path | Result |
|---|---|---|
| `clawhub-publish/xproof/SKILL.md` | `xproof/SKILL.md` | Updated (live canonical) |
| `clawhub-publish/xproof/SKILL.md` | `xproof/SKILL-v3.1.0.md` | Created (new archived snapshot) |

## Changes in v3.1.0

- **Tier 3 pricing** — updated from $0.01 to **$0.015** per proof (1M+ proofs)
- **Launch promo** — -50% on prepaid packs ≥ 1,000 certs (Tier 1: <100k all-time proofs)
- **Fetch.ai / uAgents** — `XProofuAgentMiddleware` added to integrations section
- **Hermes Skills Hub** — registered as a Hermes skill with discovery badge
- **Frontmatter version** bumped from 3.0.0 → 3.1.0

## Previous release

| Version | Commit |
|---|---|
| v3.0.0 | `0096495dd823a42086457114920fe42bcd1183f9` |
| v3.0.0 archive | `xproof/SKILL-v3.0.0.md` |
