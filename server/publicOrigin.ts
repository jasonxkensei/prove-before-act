/**
 * The single public identity used in SEO metadata, machine-readable
 * discovery documents, and permanent redirects from retired domains.
 */
export const CANONICAL_PUBLIC_ORIGIN = "https://provebeforeact.com";

const LEGACY_PUBLIC_HOSTS = new Set([
  "xproof.app",
  "www.xproof.app",
  "proofmint.replit.app",
]);

const LEGACY_DISCOVERY_PATHS = new Map([
  ["/.well-known/xproof.json", "/.well-known/provebeforeact.json"],
  ["/.well-known/xproof.md", "/.well-known/provebeforeact.md"],
  ["/.well-known/proofmint.md", "/.well-known/provebeforeact.md"],
]);

export function isLegacyPublicHost(hostname: string | undefined): boolean {
  if (!hostname) return false;
  return LEGACY_PUBLIC_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ""));
}

export function getCanonicalPublicUrl(requestTarget: string): string {
  // A request target must be an absolute path. Guard the redirect target so a
  // malformed `//host` or `/\host` request cannot turn a legacy-domain
  // redirect into an open redirect.
  const safeTarget =
    requestTarget.startsWith("/") &&
    !requestTarget.startsWith("//") &&
    !requestTarget.includes("\\")
      ? requestTarget
      : "/";
  const url = new URL(safeTarget, CANONICAL_PUBLIC_ORIGIN);
  if (url.origin !== CANONICAL_PUBLIC_ORIGIN) {
    return `${CANONICAL_PUBLIC_ORIGIN}/`;
  }
  const canonicalPath = LEGACY_DISCOVERY_PATHS.get(url.pathname);
  if (canonicalPath) url.pathname = canonicalPath;
  return url.toString();
}