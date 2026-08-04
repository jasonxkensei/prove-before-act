---
name: SDK distribution channels
description: How to publish Prove Before Act SDKs to PyPI, npm, GitHub, and clawhub/OpenClaw.
---

# Prove Before Act SDK Distribution

## Python SDK → PyPI

- **Version file:** `python-sdk/pyproject.toml` (`version = "X.Y.Z"`)
- **Changelog:** `python-sdk/CHANGELOG.md`
- **Build:** `cd python-sdk && python3 -m build` (creates `dist/xproof-X.Y.Z.tar.gz` and `.whl`)
- **Publish:** `TWINE_PASSWORD=$PYPI_API_TOKEN python3 -m twine upload --username __token__ dist/xproof-X.Y.Z*`
- **Secret:** `PYPI_API_TOKEN` (the one labeled `PYPI_TOKEN` may also work; `PYPI_API_TOKEN` is confirmed)
- **URL:** https://pypi.org/project/xproof/

## npm SDK → npm registry

- **Version file:** `npm-sdk/package.json`
- **User-Agent:** `npm-sdk/src/client.ts` → `const VERSION = "X.Y.Z"`
- **Changelog:** `npm-sdk/CHANGELOG.md`
- **Build:** Runs automatically via `prepublishOnly` hook (`tsup`)
- **Publish:** `cd npm-sdk && pnpm publish --access public --no-git-checks --registry https://registry.npmjs.org/`
- **Auth file:** `npm-sdk/.npmrc` must contain `//registry.npmjs.org/:_authToken=${NPM_ACCESS_TOKEN}`
- **Secret:** `NPM_ACCESS_TOKEN`
- **URL:** https://www.npmjs.com/package/@prove-before-act/sdk
- **Note:** bash blocks `npm` commands; use `pnpm` with explicit registry URL. See npm-publish-replit.md.

## GitHub → jasonxkensei/xProof

- **Secret:** `GITHUB_PERSONAL_ACCESS_TOKEN`
- **Normal:** `git push origin main` (works when histories are in sync)
- **Diverged:** Use GitHub Contents API file-by-file. See github-remote-divergence.md.
- **Note:** Replit auto-commits via checkpoint system; origin can diverge when CI/contributors push directly.

## clawhub/OpenClaw → jasonxkensei/xproof-openclaw-skill

- **Local SKILL.md:** `clawhub-publish/xproof/SKILL.md`
- **Frontmatter version:** bump `version: X.Y.Z` in the YAML header
- **Publish live:** PUT to `xproof/SKILL.md` on the skill repo
- **Archive:** PUT to `xproof/SKILL-vX.Y.Z.md` (new file, no SHA needed)
- **Record:** Update `clawhub-publish/PUBLISHED.md` with commit SHAs
- **Secret:** `GITHUB_PERSONAL_ACCESS_TOKEN`
- **Skill repo URL:** https://github.com/jasonxkensei/xproof-openclaw-skill
- **Before publishing to GitHub:** verify the token first with `GET /user`; if it returns 401 the user must refresh the secret. Record any pending skill publish in `clawhub-publish/PUBLISHED.md` so the next release can catch up.
- **Python release rule:** bumping `pyproject.toml` alone breaks `tests/test_version.py` — the fallback `__version__` strings in `xproof/__init__.py` and `xproof/client.py` must be bumped in lockstep.
