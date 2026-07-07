/**
 * Comparison shortlist — sessionStorage helpers.
 *
 * The leaderboard stores selected wallets here so the shortlist survives
 * navigation within the same tab (sessionStorage is cleared when the tab
 * closes or when the user explicitly compares / clears).
 *
 * Importing this module (rather than inlining the key and logic) ensures
 * that any rename of SHORTLIST_KEY is automatically reflected in tests.
 */

export const SHORTLIST_KEY = "xproof_compare_shortlist";

/**
 * Read the shortlist from storage.
 * Mirrors the useState lazy initializer in leaderboard.tsx.
 * Returns an empty Set on any error (missing key, malformed JSON, non-array).
 */
export function readShortlist(
  storage: Pick<Storage, "getItem"> = sessionStorage,
): Set<string> {
  try {
    const raw = storage.getItem(SHORTLIST_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr as string[]);
    }
  } catch {}
  return new Set();
}

/**
 * Persist the current shortlist to storage.
 * Mirrors the persistence useEffect in leaderboard.tsx.
 */
export function writeShortlist(
  wallets: Set<string>,
  storage: Pick<Storage, "setItem"> = sessionStorage,
): void {
  try {
    storage.setItem(SHORTLIST_KEY, JSON.stringify(Array.from(wallets)));
  } catch {}
}

/**
 * Remove the shortlist key from storage.
 * Used by handleCompare (before navigation) and the Clear button handler.
 */
export function clearShortlist(
  storage: Pick<Storage, "removeItem"> = sessionStorage,
): void {
  try {
    storage.removeItem(SHORTLIST_KEY);
  } catch {}
}
