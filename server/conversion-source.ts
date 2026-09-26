// Preserve ordinary campaign/partner labels without persisting arbitrary
// query strings (which can contain credentials, wallets, emails, or IDs).
const sensitivePrefix = /^(?:sk_|pk_|erd1|0x|acct|account|user|customer|wallet|api[-_]?key|token|secret|session|auth)/i;
const sensitiveWord = /(?:^|[-_])(?:credential|password|secret|token|account|wallet|email|api[-_]?key)(?:[-_]|$)/i;

export function safeConversionSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = value.trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(source)
    || sensitivePrefix.test(source)
    || sensitiveWord.test(source)
    || /[a-f0-9]{32,}/i.test(source)
    || /\d{12,}/.test(source)) return null;
  return source;
}