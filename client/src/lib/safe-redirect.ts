export function getSafeRedirectTo(redirectTo?: string, origin?: string): string {
  if (!redirectTo || !redirectTo.startsWith("/") || redirectTo.startsWith("//")) {
    return "/dashboard";
  }
  try {
    const baseOrigin = origin || (typeof window !== "undefined" ? window.location.origin : "http://localhost");
    const parsed = new URL(redirectTo, baseOrigin);
    if (parsed.origin !== baseOrigin) return "/dashboard";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/dashboard";
  }
}