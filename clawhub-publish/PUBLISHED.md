# Published — Prove Before Act SKILL.md

---

## v3.3.0 — 2026-07-30 (PENDING LIVE PUBLISH)

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
