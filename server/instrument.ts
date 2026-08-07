/**
 * Sentry server-side instrumentation.
 *
 * MUST be the first module imported in server/index.ts (before express, db, etc.)
 * so that Sentry can patch Node.js internals and capture all errors from startup.
 *
 * Graceful degradation: if SENTRY_DSN is absent the module is a no-op — the app
 * starts and runs normally without any Sentry overhead.
 */
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",

    // Capture every unhandled error — no sampling on errors.
    sampleRate: 1.0,

    // Performance tracing off for now (out of scope per task spec).
    tracesSampleRate: 0,

    // Tags that appear on every event in the Sentry dashboard.
    initialScope: {
      tags: {
        service: "provebeforeact-api",
        runtime: "node",
      },
    },
  });
} else {
  // Log once at startup so it's visible in logs but not an error.
  console.info("[sentry] SENTRY_DSN not set — error monitoring disabled");
}

export { Sentry };
