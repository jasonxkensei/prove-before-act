const PROOF_ID_PATTERN = /^[A-Za-z0-9_-]{5,128}$/;

export function parsePublicProofId(value: string, origin: string): string | null {
  const input = value.trim();
  if (PROOF_ID_PATTERN.test(input)) return input;

  try {
    const link = /^(?:www\.)?provebeforeact\.com\/proof\//i.test(input)
      ? `https://${input}`
      : input;
    const url = new URL(link, origin);
    const currentHost = new URL(origin).hostname;
    if (
      !["http:", "https:"].includes(url.protocol) ||
      ![currentHost, "provebeforeact.com", "www.provebeforeact.com"].includes(url.hostname)
    ) {
      return null;
    }

    const match = /^\/proof\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    return PROOF_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}