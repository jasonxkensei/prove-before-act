# Environment Variables Reference

This document describes every environment variable used by Prove Before Act.

## Database

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string. Format: `postgresql://user:password@host:port/dbname` |
| `PGHOST` | Auto | PostgreSQL host (extracted from DATABASE_URL on Replit) |
| `PGPORT` | Auto | PostgreSQL port (default: 5432) |
| `PGUSER` | Auto | PostgreSQL username |
| `PGPASSWORD` | Auto | PostgreSQL password |
| `PGDATABASE` | Auto | PostgreSQL database name |

On Replit, the `PG*` variables are auto-populated when you create a PostgreSQL database. For self-hosted deployments, only `DATABASE_URL` is required.

---

## Session

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | Yes | Secret key for signing session cookies. Use a random string of at least 32 characters. Generate with: `openssl rand -hex 32` |

---

## MultiversX Blockchain

| Variable | Required | Description |
|---|---|---|
| `VITE_WALLETCONNECT_PROJECT_ID` | Yes | WalletConnect Cloud project ID for wallet connections. Get one at [cloud.walletconnect.com](https://cloud.walletconnect.com). |
| `PROOFMINT_WALLET_ADDRESS` | Yes | MultiversX wallet address (`erd1...`) that receives certification fees. |
| `MULTIVERSX_GATEWAY_URL` | Optional | MultiversX gateway URL. Defaults to `https://gateway.multiversx.com` (Mainnet). Use `https://devnet-gateway.multiversx.com` for Devnet. |
| `MULTIVERSX_CHAIN_ID` | Optional | Chain ID. `1` for Mainnet, `D` for Devnet, `T` for Testnet. Default: `1`. |
| `MULTIVERSX_PRIVATE_KEY` | Optional | Private key for server-side transaction signing. Only needed if server-side signing is enabled. |
| `MULTIVERSX_SENDER_ADDRESS` | Optional | Sender address for server-side transactions. Must match the private key. |

For standard usage (user signs with their own wallet via xPortal), only `VITE_WALLETCONNECT_PROJECT_ID` and `PROOFMINT_WALLET_ADDRESS` are needed.

---

## Replit (Auto-populated)

| Variable | Required | Description |
|---|---|---|
| `REPL_ID` | Auto | Replit project identifier. Auto-populated on Replit. |
| `REPLIT_DOMAINS` | Auto | Production domain(s) for the Replit deployment. |
| `REPLIT_DEV_DOMAIN` | Auto | Development domain for preview. |

These are automatically set by the Replit environment. Do not set manually unless self-hosting and simulating Replit behavior.

---

## Admin Authorization

> **Security note:** Both variables use **fail-closed semantics**. If neither `ADMIN_SECRET` nor `ADMIN_WALLETS` is configured in a deployment, every admin-only endpoint (`/api/admin/*`) will respond with `403 Forbidden`. There is no circumstance in which admin routes are reachable without at least one of these variables being set.

| Variable | Required | Description |
|---|---|---|
| `ADMIN_WALLETS` | Recommended in production | Comma-separated list of MultiversX wallet addresses (`erd1...`) that are granted admin access. Example: `erd1abc...,erd1xyz...`. When set, only sessions authenticated as one of these wallets can reach admin routes (in addition to callers presenting a valid `ADMIN_SECRET` header). |
| `ADMIN_SECRET` | Optional | A shared secret string. If set, any HTTP request that sends this value in the `x-admin-secret` header is granted admin access without a wallet session. Use a strong random value (e.g. `openssl rand -hex 32`). Intended for server-to-server or CI automation use only. |

**Required for production:** At least one of `ADMIN_WALLETS` or `ADMIN_SECRET` must be configured, otherwise all admin endpoints are permanently inaccessible (by design). Omitting both variables in production is a safe default — it simply disables the admin API until the configuration is intentionally supplied.

---

## Variable Prefixes

- **`VITE_`** prefix: Variables prefixed with `VITE_` are exposed to the frontend via Vite's `import.meta.env`. Never prefix sensitive values (API keys, secrets) with `VITE_`.
- All other variables are server-side only and never sent to the browser.

---

## Quick Setup

```bash
# Generate a session secret
openssl rand -hex 32

# Minimum required for development
DATABASE_URL=postgresql://...
SESSION_SECRET=<generated-secret>
VITE_WALLETCONNECT_PROJECT_ID=<your-project-id>
PROOFMINT_WALLET_ADDRESS=erd1...
```
