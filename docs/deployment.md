# Prove Before Act Deployment Guide

## Prerequisites

- **Node.js** 20 or later
- **npm** 9 or later
- **PostgreSQL** 14 or later (Neon recommended for managed hosting)
- A **MultiversX wallet** with a private key for server-side transaction signing
- **WalletConnect** project ID (for mobile wallet connections)

---

## Replit Deployment

Replit is the primary deployment platform for Prove Before Act. The project is preconfigured with a workflow that runs the development server and handles both frontend and backend.

### Workflow Configuration

The application uses a single workflow named **Start application** that runs:

```
npm run dev
```

This command starts the Express backend server with Vite middleware for frontend development. In production (Replit deployments), the frontend is pre-built and served as static files.

### Steps

1. Fork or import the Prove Before Act repository into Replit.
2. Configure all required environment variables (see the Environment Variables section below).
3. The database is automatically provisioned via the Replit PostgreSQL integration. The `DATABASE_URL` and related `PG*` variables are set automatically.
4. Run the **Start application** workflow. The server binds to `0.0.0.0:5000`.
5. Replit automatically assigns a public URL to the application.

### Database Provisioning on Replit

The Replit PostgreSQL integration (Neon-backed) automatically provides:

- `DATABASE_URL` -- Full connection string
- `PGHOST` -- Database hostname
- `PGPORT` -- Database port
- `PGUSER` -- Database user
- `PGPASSWORD` -- Database password
- `PGDATABASE` -- Database name

These are injected as environment variables. No manual database setup is required on Replit.

### Running Migrations on Replit

After the database is provisioned, run migrations using Drizzle Kit:

```bash
npx drizzle-kit push
```

This synchronizes the database schema with the Drizzle schema defined in `shared/schema.ts`.

---

## Self-Hosted Deployment

### 1. Clone the Repository

```bash
git clone <repository-url>
cd xProof
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up PostgreSQL

Create a PostgreSQL database and note the connection details. Using Neon (recommended):

1. Create a Neon project at https://neon.tech.
2. Create a database (e.g., `provebeforeact`).
3. Copy the connection string.

Alternatively, use a local PostgreSQL instance:

```bash
createdb provebeforeact
```

### 4. Configure Environment Variables

Create a `.env` file in the project root (see the Environment Variables section below for all required variables):

```bash
DATABASE_URL=postgresql://user:password@host:5432/provebeforeact
SESSION_SECRET=<random-64-char-string>
MULTIVERSX_PRIVATE_KEY=<hex-encoded-private-key>
MULTIVERSX_SENDER_ADDRESS=erd1...
MULTIVERSX_CHAIN_ID=1
MULTIVERSX_GATEWAY_URL=https://gateway.multiversx.com
VITE_WALLETCONNECT_PROJECT_ID=<walletconnect-project-id>
```

### 5. Run Database Migrations

Push the schema to the database:

```bash
npx drizzle-kit push
```

To generate migration SQL files (for review before applying):

```bash
npx drizzle-kit generate
```

### 6. Build for Production

```bash
npm run build
```

This compiles the TypeScript backend and builds the Vite frontend into `dist/`.

### 7. Start the Production Server

```bash
NODE_ENV=production npm start
```

The server binds to port 5000 by default. Override with the `PORT` environment variable.

### 8. Reverse Proxy (Recommended)

Place the application behind a reverse proxy (nginx, Caddy) for TLS termination:

**nginx example:**

```nginx
server {
    listen 443 ssl;
    server_name provebeforeact.com;

    ssl_certificate /etc/ssl/certs/provebeforeact.pem;
    ssl_certificate_key /etc/ssl/private/provebeforeact.key;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Random string for signing session cookies (minimum 32 characters) |
| `MULTIVERSX_PRIVATE_KEY` | Hex-encoded ed25519 private key for server-side transaction signing |
| `MULTIVERSX_SENDER_ADDRESS` | MultiversX wallet address corresponding to the private key (`erd1...`) |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud project ID for mobile wallet connections |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | Server listening port |
| `MULTIVERSX_CHAIN_ID` | `1` | Chain ID: `1` (mainnet), `D` (devnet), `T` (testnet) |
| `MULTIVERSX_GATEWAY_URL` | `https://gateway.multiversx.com` | MultiversX gateway API URL |
| `PROOFMINT_WALLET_ADDRESS` | (none) | Legacy wallet address (backward compatibility) |
| `PGHOST` | (from DATABASE_URL) | PostgreSQL host |
| `PGPORT` | (from DATABASE_URL) | PostgreSQL port |
| `PGUSER` | (from DATABASE_URL) | PostgreSQL user |
| `PGPASSWORD` | (from DATABASE_URL) | PostgreSQL password |
| `PGDATABASE` | (from DATABASE_URL) | PostgreSQL database name |

### Replit-Specific

These are automatically set by the Replit environment:

| Variable | Description |
|----------|-------------|
| `REPL_ID` | Replit repl identifier |
| `REPLIT_DOMAINS` | Public domain assigned by Replit |
| `REPLIT_DEV_DOMAIN` | Development domain |

---

## Database Setup and Migration

### Schema Definition

The database schema is defined in `shared/schema.ts` using Drizzle ORM's table builder functions. This file is the single source of truth for both database structure and TypeScript types.

### Tables

| Table | Purpose |
|-------|---------|
| `sessions` | Express session storage (connect-pg-simple) |
| `users` | Wallet-based user accounts with payment data |
| `certifications` | File certification records with blockchain references |
| `api_keys` | API keys for programmatic access |
| `acp_checkouts` | Agent Commerce Protocol checkout sessions |

### Migration Commands

**Push schema directly (development/initial setup):**

```bash
npx drizzle-kit push
```

This compares the schema definition with the live database and applies changes directly. Suitable for development and initial deployment.

**Generate migration files (production):**

```bash
npx drizzle-kit generate
```

This creates SQL migration files in the `migrations/` directory. Review them before applying.

**View current schema status:**

```bash
npx drizzle-kit studio
```

Opens Drizzle Studio, a visual database browser, for inspecting tables and data.

### Configuration

The Drizzle configuration is in `drizzle.config.ts`. It reads the `DATABASE_URL` environment variable and targets the `shared/schema.ts` file for schema definitions. The migrations output directory is `./migrations`.

---

## Production Considerations

### Session Security

In production, ensure the following session cookie settings (configured in `server/replitAuth.ts`):

- `secure: true` -- Cookies are only sent over HTTPS
- `httpOnly: true` -- Cookies are not accessible via client-side JavaScript
- `sameSite: "lax"` -- Provides CSRF protection while allowing top-level navigations
- `maxAge: 86400000` -- Sessions expire after 24 hours

The `SESSION_SECRET` must be a cryptographically random string of at least 32 characters. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### HTTPS

Prove Before Act requires HTTPS in production for:

- Secure session cookies (`secure: true`)
- MultiversX Native Auth origin verification
- WalletConnect relay connections
On Replit, HTTPS is provided automatically. For self-hosted deployments, use a reverse proxy with TLS termination (see the nginx example above).

### Trust Proxy

The Express application is configured with `trust proxy: 1`. This is required when running behind a reverse proxy (Replit, nginx, Cloudflare) to correctly resolve client IP addresses and the `X-Forwarded-Proto` header for secure cookie handling.

### Content Security Policy

The server sets a strict Content Security Policy header that allows:

- Scripts from `self`, `cdn.jsdelivr.net`, and `fonts.googleapis.com` (plus `unsafe-inline` and `unsafe-eval` for the MultiversX SDK)
- Styles from `self`, `fonts.googleapis.com`, and inline styles
- Connections to MultiversX APIs, WalletConnect relays, and the application origin
- Frames for MultiversX Web Wallet domains

Review and tighten the CSP in `server/index.ts` if your deployment does not require all of these sources.

### Logging

The server logs all API requests with method, path, status code, and response time. Logs are written to stdout and can be captured by your process manager or logging service.

Log format:

```
POST /api/certifications 201 in 45ms :: {"id":"...","fileName":"..."}
```

Response bodies are truncated at 80 characters in logs.

### Process Management

For self-hosted production deployments, use a process manager to keep the server running:

**Using PM2:**

```bash
npm install -g pm2
pm2 start npm --name prove-before-act -- start
pm2 save
pm2 startup
```

**Using systemd:**

```ini
[Unit]
Description=Prove Before Act Server
After=network.target

[Service]
Type=simple
User=provebeforeact
WorkingDirectory=/opt/provebeforeact
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
Environment=NODE_ENV=production
Environment=PORT=5000
EnvironmentFile=/opt/provebeforeact/.env

[Install]
WantedBy=multi-user.target
```

---

## Health Monitoring

The application exposes a health check endpoint for monitoring:

```
GET /api/acp/health
```

**Response (200):**

```json
{
  "status": "ok",
  "service": "Prove Before Act",
  "timestamp": "2026-02-01T12:00:00.000Z"
}
```

Use this endpoint with uptime monitoring services (UptimeRobot, Pingdom, or custom scripts) to verify the application is running and responsive.

### Monitoring Checklist

- **Application health** -- Poll `GET /api/acp/health` every 60 seconds
- **Database connectivity** -- The health endpoint implicitly verifies database access
- **Blockchain connectivity** -- Monitor transaction submission success rates via application logs
- **SSL certificate** -- Monitor certificate expiry if self-hosted
- **Disk space** -- Monitor if generating and storing PDF certificates locally
- **Memory usage** -- Node.js process memory; set `--max-old-space-size` if needed

---

## Upgrading

### Updating Dependencies

```bash
npm update
```

### Applying Schema Changes

After modifying `shared/schema.ts`:

1. Generate a migration: `npx drizzle-kit generate`
2. Review the generated SQL in `migrations/`
3. Apply the migration: `npx drizzle-kit push`

### Zero-Downtime Deployment

For zero-downtime deployments on self-hosted infrastructure:

1. Build the new version: `npm run build`
2. Apply any database migrations: `npx drizzle-kit push`
3. Restart the application process (PM2: `pm2 reload prove-before-act`)

On Replit, deployments are handled automatically when the workflow restarts.
