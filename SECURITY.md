# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Prove Before Act, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please contact the maintainers directly via email or GitHub private vulnerability reporting.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 5 business days
- **Fix or mitigation**: as soon as possible depending on severity

## Security Architecture

### File Privacy

Prove Before Act **never stores or transmits user files**. SHA-256 hashing is performed entirely in the browser using the Web Crypto API. Only the hash (a 64-character hex string) is sent to the server and recorded on-chain.

### Authentication

- Wallet authentication uses MultiversX **Native Auth**, which requires cryptographic proof (signature) from the user's wallet.
- Sessions are stored server-side in PostgreSQL.
- API keys for agent access use `pm_` prefixed bearer tokens, hashed before storage.

### Blockchain Security

- Transactions are signed client-side by the user's wallet (xPortal, Web Wallet, or WalletConnect).
- Optional server-side signing uses a private key stored in environment variables &mdash; never committed to the repository.
- All transaction hashes are independently verifiable on the MultiversX Explorer.

### Payment Security

- All payments are processed through xMoney in EGLD. Prove Before Act never stores payment credentials.
- xMoney webhooks use HMAC SHA-256 signature verification with constant-time comparison.

### Data Protection

- Database credentials and API keys are stored as encrypted secrets, never in source code.
- HTTPS is enforced in production.
- Session cookies use `httpOnly`, `sameSite`, and `secure` flags in production.

## Supported Versions

| Version | Supported |
|---|---|
| Latest (main branch) | Yes |
| Previous releases | Best effort |

## Dependencies

We monitor and update dependencies regularly to address known vulnerabilities. Security-critical updates (such as `qs`, `jspdf`, and framework dependencies) are prioritized.

### Known Unresolved Dependency CVEs

The following vulnerabilities are currently unresolved due to upstream blockers. Each entry includes the blocker reason and a next-review date.

| CVE / Advisory | Package | Severity | Blocker | Owner | Next Review |
|---|---|---|---|---|---|
| GHSA-wj6h-64fc-37mp | `ecdsa@0.19.2` (Python) | High | 0.19.2 is the latest PyPI release; no upstream fix published | Security team | 2026-07-22 |
| GHSA-4w7w-66w2-5vf9 (×2) | `vite@5.4.21` | Medium | Fix requires Vite 8.x — major breaking change affecting build pipeline and all Vite plugins | Platform team | 2026-07-22 |
| GHSA-67mh-4wv8-2f99 | `esbuild@0.18.20` (via `@esbuild-kit/core-utils` in drizzle-kit) | Medium | `@esbuild-kit/core-utils` is an archived package used internally by drizzle-kit; upgrade path requires drizzle-kit to cut a new release or Vite 8 migration | Platform team | 2026-07-22 |
| GHSA-67mh-4wv8-2f99 (×2) | `esbuild@0.21.5` (via Vite 5 internal) | Medium | Same root cause as Vite advisory above; both esbuild entries clear when Vite 8 migration is completed | Platform team | 2026-07-22 |

**Action items:**
- Monitor [`ecdsa` PyPI releases](https://pypi.org/project/ecdsa/#history) and apply fix immediately when available.
- Track [Vite 8 migration guide](https://vitejs.dev) and plan breaking-change upgrade (clears 4 of the 6 blocked advisories in one go).
- Re-evaluate all 6 entries at next scheduled security review (2026-07-22).
