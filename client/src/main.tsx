import "./polyfills"; // MUST be first - fixes MultiversX SDK Node.js dependencies
import * as Sentry from "@sentry/react";
import { migrateLegacyStorageKeys } from './lib/auth-storage';
// Run once before anything reads localStorage — moves xproof_* keys → pba_* without
// breaking existing sessions (users stay logged in after the rebrand key rename).
migrateLegacyStorageKeys();
import { createRoot } from "react-dom/client";
import { initApp } from '@multiversx/sdk-dapp/out/methods/initApp/initApp';
import type { InitAppType } from '@multiversx/sdk-dapp/out/methods/initApp/initApp.types';
import { EnvironmentsEnum } from '@multiversx/sdk-dapp/out/types/enums.types';
import App from "./App";
import "./index.css";
import { logger } from './lib/logger';

// ── Sentry browser SDK ────────────────────────────────────────────────────────
// Graceful degradation: no-op when VITE_SENTRY_DSN is absent so local dev and
// environments without Sentry configured work identically.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,

    // Capture every error — no sampling on errors.
    sampleRate: 1.0,

    // Performance tracing off for now (out of scope).
    tracesSampleRate: 0,

    // Include component tree in error reports when available.
    integrations: [],

    initialScope: {
      tags: {
        service: "provebeforeact-web",
        runtime: "browser",
      },
    },
  });
}
// ─────────────────────────────────────────────────────────────────────────────

logger.log('MultiversX Network: MAINNET');

const config: InitAppType = {
  storage: {
    getStorageCallback: () => localStorage
  },
  dAppConfig: {
    environment: EnvironmentsEnum.mainnet,
    nativeAuth: {
      expirySeconds: 3600, // AUTH-M01: 1 hour — matches server maxExpirySeconds
      tokenExpirationToastWarningSeconds: 300
    },
  }
};

logger.log('MultiversX Config:', JSON.stringify(config, null, 2));

initApp(config);

const root = document.getElementById("root")!;

createRoot(root).render(
  <Sentry.ErrorBoundary
    fallback={({ error, resetError }) => (
      <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
        <h2>Something went wrong</h2>
        <p style={{ color: "#666", marginBottom: "1rem" }}>
          {error instanceof Error ? error.message : "An unexpected error occurred."}
        </p>
        <button onClick={resetError} style={{ padding: "0.5rem 1rem", cursor: "pointer" }}>
          Try again
        </button>
      </div>
    )}
  >
    <App />
  </Sentry.ErrorBoundary>
);
