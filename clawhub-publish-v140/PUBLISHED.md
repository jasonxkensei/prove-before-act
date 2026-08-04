# Published — Prove Before Act v3.1.0 SKILL.md

**Date:** 2026-05-03T16:45:18Z  
**Target repo:** https://github.com/jasonxkensei/xproof-openclaw-skill  
**Branch:** main

## Verification

| Item | Value |
|---|---|
| Commit SHA | `0096495dd823a42086457114920fe42bcd1183f9` |
| Commit URL | https://github.com/jasonxkensei/xproof-openclaw-skill/commit/0096495dd823a42086457114920fe42bcd1183f9 |
| Commit message | `chore: add plaintext warning, x402 spending-cap advice, llms.txt note (v3.1.0)` |
| SKILL.md blob SHA | `6304fb565812e264031026c1a5bcf72b4c8101a3` |
| Raw URL | https://raw.githubusercontent.com/jasonxkensei/xproof-openclaw-skill/main/xproof/SKILL.md |

Raw URL verification (confirmed via GitHub Contents API after push):
- `version: 3.1.0` ✓
- `NEVER send plaintext content to provebeforeact.com` ✓
- `spending cap` / x402 autonomous payment warning ✓
- `llms.txt` / `llms-full.txt` runtime note ✓

## Files pushed

| Local path | GitHub path | Result |
|---|---|---|
| `clawhub-publish-v140/xproof/SKILL.md` | `xproof/SKILL.md` | Updated — SHA 6304fb5 |
| `clawhub-publish-v140/xproof/references/certification.md` | `xproof/references/certification.md` | Updated |
| `clawhub-publish-v140/xproof/references/x402.md` | `xproof/references/x402.md` | Updated |
| `clawhub-publish-v140/xproof/references/mcp.md` | `xproof/references/mcp.md` | Updated |
| `clawhub-publish-v140/xproof/references/api-reference.md` | `xproof/references/api-reference.md` | Updated |

## Quick Install URL (now serves updated content)

```bash
curl -sL https://raw.githubusercontent.com/jasonxkensei/xproof-openclaw-skill/main/xproof/SKILL.md \
  > .agent/skills/prove-before-act/SKILL.md
```

## Note on @octokit/rest

During this task, `@octokit/rest` was installed for exploration but the
final implementation used Node.js built-in `https` module exclusively.
The package is unused and should be removed when the environment allows.
