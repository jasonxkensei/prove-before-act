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

export const SHORTLIST_KEY = "pba_compare_shortlist";

/** Hard cap on how many wallets can be in the comparison shortlist. */
export const SHORTLIST_MAX = 6;

/**
 * Toggle a wallet in the shortlist, enforcing the SHORTLIST_MAX cap.
 *
 * - If the wallet is already in `prev`, it is removed (deselect always works).
 * - If the wallet is not in `prev` and `prev.size < SHORTLIST_MAX`, it is added.
 * - If the wallet is not in `prev` and `prev.size >= SHORTLIST_MAX`, the call
 *   is a no-op — the cap is enforced and the returned Set is identical in
 *   membership to `prev`.
 *
 * Always returns a new Set so React state updates fire correctly.
 */
export function toggleWallet(prev: Set<string>, wallet: string): Set<string> {
  const next = new Set(prev);
  if (next.has(wallet)) {
    next.delete(wallet);
  } else if (next.size < SHORTLIST_MAX) {
    next.add(wallet);
  }
  return next;
}

/**
 * Minimum number of selected wallets required for the floating compare bar
 * to render. leaderboard.tsx must use this constant in its JSX guard
 * (`selectedWallets.size >= SHORTLIST_BAR_MIN && <FloatingBar />`) rather
 * than a hardcoded literal, so tests can assert against the exact value the
 * component renders with.
 */
export const SHORTLIST_BAR_MIN = 1;

/**
 * Minimum number of selected wallets required to enable the "Compare"
 * button inside the floating bar. leaderboard.tsx must use this constant
 * in its `disabled={...}` prop rather than a hardcoded literal.
 */
export const SHORTLIST_COMPARE_MIN = 2;

/** True when the floating compare bar should be visible. */
export function shouldShowCompareBar(selectedWallets: Set<string>): boolean {
  return selectedWallets.size >= SHORTLIST_BAR_MIN;
}

/** True when the "Compare" button inside the floating bar should be enabled. */
export function isCompareEnabled(selectedWallets: Set<string>): boolean {
  return selectedWallets.size >= SHORTLIST_COMPARE_MIN;
}

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
