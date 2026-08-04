import { NativeAuthServer } from '@multiversx/sdk-native-auth-server';

// AUTH-H3: Build the accepted-origins list from all Replit domain env vars.
// The original code only used REPL_ID.replit.dev which does NOT match deployed
// apps (they use REPLIT_DOMAINS / REPL_SLUG.REPL_OWNER.repl.co / custom domain).
// When the origin doesn't match, nativeAuthServer.validate() throws and every
// /api/auth/wallet/sync call returns 401 — forcing clients to silently fall back
// to the disabled simple-sync path. Fix: read all known Replit origin variables
// and handle comma-separated multi-domain values.
function buildAcceptedOrigins(): string[] {
  const origins = new Set<string>();

  // Always include production domains
  origins.add('https://xproof.app');
  origins.add('https://www.xproof.app');

  // REPLIT_DOMAINS / REPL_DOMAINS — may be comma-separated (e.g. "xproof.app,www.xproof.app")
  for (const envVar of ['REPLIT_DOMAINS', 'REPL_DOMAINS']) {
    const val = process.env[envVar] || '';
    for (const domain of val.split(',')) {
      const trimmed = domain.trim();
      if (trimmed) {
        origins.add(`https://${trimmed}`);
      }
    }
  }

  // REPLIT_DEV_DOMAIN — the *.replit.dev preview domain used in development
  const devDomain = process.env.REPLIT_DEV_DOMAIN || '';
  if (devDomain) {
    origins.add(`https://${devDomain}`);
  }

  // REPL_SLUG + REPL_OWNER construct the legacy slug.owner.repl.co domain
  const slug = process.env.REPL_SLUG || '';
  const owner = process.env.REPL_OWNER || '';
  if (slug && owner) {
    origins.add(`https://${slug}.${owner}.repl.co`);
  }

  // Development localhost fallback — only when no Replit-specific domain is found
  if (origins.size === 2) {
    // Only xproof.app domains were added — must be local dev
    origins.add('http://localhost:5000');
    origins.add('http://localhost:3000');
  }

  return [...origins];
}

// Export so other modules (e.g. auth route CSRF checks) can reuse the same list
// without duplicating the Replit-domain logic.
export function getAcceptedOrigins(): string[] {
  return buildAcceptedOrigins();
}

// Initialize Native Auth server for token verification
const nativeAuthServer = new NativeAuthServer({
  apiUrl: 'https://api.multiversx.com', // Mainnet API
  maxExpirySeconds: 3600, // AUTH-M01: 1 hour — reduces stolen-token window; client config updated to match
  acceptedOrigins: buildAcceptedOrigins(),
});

export interface DecodedNativeAuthToken {
  address: string;
  body: string;
  signature: string;
  origin: string;
  blockHash: string;
  ttl: number;
  extraInfo?: {
    timestamp: number;
  };
}

/**
 * Verify MultiversX Native Auth token
 * Returns the decoded token with wallet address if valid, throws if invalid
 */
export async function verifyNativeAuthToken(
  token: string
): Promise<DecodedNativeAuthToken> {
  try {
    // Decode the token to extract data
    const decoded = nativeAuthServer.decode(token);
    
    // Validate the token (checks signature, expiration, origin)
    await nativeAuthServer.validate(token);
    
    return decoded;
  } catch (error: any) {
    // AUTH-M07 (server side): do not propagate SDK internals — callers log the
    // original message; callers that surface errors to clients must use a generic
    // message (see auth.ts catch block).
    throw new Error('Invalid or expired authentication token');
  }
}

/**
 * Extract Bearer token from Authorization header
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.replace('Bearer ', '');
}
