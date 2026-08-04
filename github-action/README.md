# Prove Before Act Certify — GitHub Action

[![Marketplace](https://img.shields.io/badge/Marketplace-xProof%20Certify-blue?logo=github)](https://github.com/marketplace/actions/xproof-certify)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/jasonxkensei/xProof-Action)](https://github.com/jasonxkensei/xProof-Action/releases)

> Anchor a verifiable, on-chain proof of your build artifacts and AI agent outputs — in 3 lines of YAML.

Certify build artifacts (or anything hashable) on the MultiversX blockchain directly from your CI/CD pipeline. Files are hashed locally with SHA-256 and never leave your runner — only the hash is sent to Prove Before Act. Get back a permanent, publicly verifiable proof, a status badge, and a JSON attestation you can attach to releases.

## Get started in 2 minutes

1. Grab an API key: sign in at [provebeforeact.com](https://provebeforeact.com), connect a wallet, and create a key under **Settings → API Keys** ([direct link](https://provebeforeact.com/settings)).
2. Add it to your repo as a secret named `XPROOF_API_KEY` (**Settings → Secrets and variables → Actions**).
3. Drop this into any workflow:

```yaml
name: Certify Release
on:
  push:
    branches: [main]

jobs:
  certify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build
        run: npm run build && zip -r build.zip dist/

      - name: Certify with Prove Before Act
        uses: jasonxkensei/xProof-Action@v1
        with:
          api_key: ${{ secrets.XPROOF_API_KEY }}
          files: 'build.zip'
```

That's it — every push to `main` now anchors a tamper-evident proof of your build artifact on-chain.

> **No API key yet, or building an autonomous agent instead of a CI pipeline?** Prove Before Act also supports pay-per-call certification with no account via the **x402** protocol (USDC on Base), through the [`@prove-before-act/sdk` npm SDK](https://www.npmjs.com/package/@prove-before-act/sdk) or [`Prove Before Act` PyPI SDK](https://pypi.org/project/xproof/). This GitHub Action always uses an API key because CI runners need a stable, revocable credential rather than a per-call wallet signature.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | Yes | — | Prove Before Act API key (`pm_xxx`). Store as a GitHub secret. |
| `files` | Yes | — | Files or glob patterns to certify (space-separated). |
| `author_name` | No | `''` | Author name to attach to the certification. |
| `metadata` | No | `''` | JSON object merged into the certification metadata. Use this for AI-agent context, e.g. `{"model_hash":"...","strategy_hash":"...","confidence_level":0.8}`. |
| `fail_on_error` | No | `'true'` | Fail the step if any file could not be certified. Set to `'false'` to only warn and keep the job green. |
| `max_retries` | No | `'3'` | Retry attempts per file on transient errors (HTTP 429 or 5xx). |
| `api_url` | No | `https://provebeforeact.com` | API URL (override for testing). |

## Outputs

| Output | Description |
|--------|-------------|
| `proof_ids` | Comma-separated proof IDs |
| `proof_urls` | Comma-separated verification URLs |
| `badge_urls` | Comma-separated badge SVG URLs |
| `badge_markdown` | Ready-to-paste Markdown badge snippets, one per line |
| `proof_json` | Path to JSON attestation file — attach to GitHub Releases for provenance |
| `summary` | Human-readable summary |
| `certified_count` | Number of files successfully certified |
| `failed_count` | Number of files that failed to certify |

## Examples

### Certify a single file

```yaml
- name: Certify
  uses: jasonxkensei/xProof-Action@v1
  with:
    api_key: ${{ secrets.XPROOF_API_KEY }}
    files: 'release.tar.gz'
```

### Certify multiple files

```yaml
- name: Certify
  id: certify
  uses: jasonxkensei/xProof-Action@v1
  with:
    api_key: ${{ secrets.XPROOF_API_KEY }}
    files: 'build.zip package.json contracts/main.sol'
    author_name: 'CI Bot'

- name: Show results
  run: echo "Proofs: ${{ steps.certify.outputs.proof_urls }}"
```

### Certify an AI agent's output (reasoning + decision context)

Any file can be certified — including a JSON dump of an agent's reasoning trace or final answer. Attach `metadata` so the proof carries model and decision provenance, not just a hash:

```yaml
- name: Export agent output
  run: node ./scripts/export-agent-output.js > agent-output.json

- name: Certify agent output
  uses: jasonxkensei/xProof-Action@v1
  with:
    api_key: ${{ secrets.XPROOF_API_KEY }}
    files: 'agent-output.json'
    author_name: 'trading-agent-v3'
    metadata: '{"model_hash":"sha256:abc123...","strategy_hash":"sha256:def456...","confidence_level":0.92,"decision_id":"trade-2026-07-08-001","threshold_stage":"final"}'
```

### Certify only on release tags (conditional usage)

```yaml
on:
  push:
    tags: ['v*']

jobs:
  certify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run build && zip -r build.zip dist/

      - name: Certify with Prove Before Act
        if: startsWith(github.ref, 'refs/tags/v')
        uses: jasonxkensei/xProof-Action@v1
        with:
          api_key: ${{ secrets.XPROOF_API_KEY }}
          files: 'build.zip'
```

### Attach attestation to GitHub Release

```yaml
- name: Certify
  id: certify
  uses: jasonxkensei/xProof-Action@v1
  with:
    api_key: ${{ secrets.XPROOF_API_KEY }}
    files: 'build.zip'

- name: Upload attestation to Release
  uses: softprops/action-gh-release@v2
  with:
    files: ${{ steps.certify.outputs.proof_json }}
```

The attestation JSON contains full provenance data:

```json
{
  "xproof_attestation": "1.0",
  "timestamp": "2026-02-12T10:30:00Z",
  "blockchain": "MultiversX",
  "source": {
    "repository": "owner/repo",
    "commit": "abc1234...",
    "ref": "refs/heads/main",
    "run_id": "123456789"
  },
  "artifacts": [
    {
      "filename": "build.zip",
      "sha256": "a1b2c3d4...",
      "proof_id": "uuid-here",
      "verify_url": "https://provebeforeact.com/proof/uuid-here",
      "badge_url": "https://provebeforeact.com/badge/uuid-here",
      "tx_hash": "abc123...",
      "explorer_url": "https://explorer.multiversx.com/transactions/abc123..."
    }
  ]
}
```

### Add a badge to your README

Use the `badge_markdown` output directly, or build it manually:

```markdown
[![Prove Before Act Verified](https://provebeforeact.com/badge/{proof_id})](https://provebeforeact.com/proof/{proof_id})
```

### Keep the job green even if certification fails

By default the step fails the job if any file couldn't be certified (`fail_on_error: 'true'`). To only warn instead:

```yaml
- name: Certify with Prove Before Act
  uses: jasonxkensei/xProof-Action@v1
  with:
    api_key: ${{ secrets.XPROOF_API_KEY }}
    files: 'build.zip'
    fail_on_error: 'false'
```

## Error handling & reliability

- **Transient errors (HTTP 429 or 5xx):** retried automatically with exponential backoff, up to `max_retries` (default 3) attempts per file.
- **Non-retryable errors (e.g. 400, 401, 402, 403):** reported immediately via `::error::` and not retried, since retrying wouldn't change the outcome (bad request, invalid key, insufficient credits, or access denied).
- **Job outcome:** with the default `fail_on_error: 'true'`, the step exits non-zero if any file fails, so downstream steps (releases, deploys) don't run against an uncertified build. Set `fail_on_error: 'false'` to opt out.
- **Rate limits:** if you hit rate limits certifying many files in one run, increase `max_retries` or split files across multiple steps/jobs.
- **Network/API outage:** files are still hashed and attempted independently — one failing file doesn't stop the others from being certified.

## How it works

1. Calculates SHA-256 hash of each file locally (files never leave your runner)
2. Sends only the hash, filename, and optional metadata to the Prove Before Act API
3. Prove Before Act anchors the hash on the MultiversX blockchain
4. Returns verification URLs, badges, and a JSON attestation file

**Cost:** $0.01 per certification — flat rate, no tiers. Current pricing: https://provebeforeact.com/api/pricing

**Get an API key:** Visit [provebeforeact.com/settings](https://provebeforeact.com/settings) and connect your wallet.

## More examples

See the [`examples/`](./examples) folder for complete, runnable workflow files.

## License

MIT — see [LICENSE](./LICENSE).
