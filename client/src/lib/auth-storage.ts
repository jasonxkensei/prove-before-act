/**
 * Shared auth-token storage helpers.
 *
 * Centralising the key names and the cleanup function here means:
 *  - wallet-login-modal.tsx and useWalletAuth.ts both reference the same
 *    string literals (no silent rename / drift).
 *  - Tests can import and call the real production function instead of
 *    duplicating the logic inline.
 */

// AUTH-M1: A specific, well-known key avoids picking up tokens from
// third-party libraries via a broad localStorage scan (injection risk).
//
// MIGRATION NOTE: The canonical key was renamed from 'xproof_native_auth_token'
// to 'pba_native_auth_token' as part of the Prove Before Act rebrand.
// migrateLegacyStorageKeys() is called once at app startup (main.tsx) to
// transparently move any data stored under the old key — existing sessions
// are preserved without any user-visible interruption.
export const PBA_NATIVE_AUTH_TOKEN_KEY = 'pba_native_auth_token';

/** @deprecated Use PBA_NATIVE_AUTH_TOKEN_KEY */
export const XPROOF_NATIVE_AUTH_TOKEN_KEY = PBA_NATIVE_AUTH_TOKEN_KEY;

// Compare-shortlist key (also migrated)
export const PBA_COMPARE_SHORTLIST_KEY = 'pba_compare_shortlist';
/** @deprecated Use PBA_COMPARE_SHORTLIST_KEY */
export const XPROOF_COMPARE_SHORTLIST_KEY = 'xproof_compare_shortlist';

/**
 * One-time migration from legacy xproof_* localStorage keys to pba_* keys.
 *
 * Safe to call multiple times — skips any key that already has a value at the
 * new name so we never overwrite a freshly-written token with a stale one.
 * Should be called as early as possible in the app lifecycle (e.g. main.tsx)
 * so that every downstream consumer already sees the new key.
 */
export function migrateLegacyStorageKeys(): void {
  try {
    // 1. Native auth token
    if (
      !localStorage.getItem(PBA_NATIVE_AUTH_TOKEN_KEY) &&
      localStorage.getItem('xproof_native_auth_token')
    ) {
      localStorage.setItem(
        PBA_NATIVE_AUTH_TOKEN_KEY,
        localStorage.getItem('xproof_native_auth_token')!,
      );
      localStorage.removeItem('xproof_native_auth_token');
    }

    // 2. Compare shortlist
    if (
      !localStorage.getItem(PBA_COMPARE_SHORTLIST_KEY) &&
      localStorage.getItem(XPROOF_COMPARE_SHORTLIST_KEY)
    ) {
      localStorage.setItem(
        PBA_COMPARE_SHORTLIST_KEY,
        localStorage.getItem(XPROOF_COMPARE_SHORTLIST_KEY)!,
      );
      localStorage.removeItem(XPROOF_COMPARE_SHORTLIST_KEY);
    }
  } catch {
    // localStorage may be blocked in private mode — ignore silently
  }
}

/**
 * Belt-and-suspenders logout cleanup.
 *
 * Removes all token key variants that may be present in localStorage:
 *   - pba_native_auth_token    (current primary key)
 *   - xproof_native_auth_token (legacy key, pre-rebrand)
 *   - nativeAuthToken           (legacy key, written by older app versions)
 *   - loginToken                (legacy key, written by older app versions)
 *
 * The sync path (syncAndRedirect in wallet-login-modal.tsx) already removes
 * these on a successful login cycle. handleLogout is the authoritative
 * fallback for sign-out and for any edge case where that cleanup was skipped.
 */
export function handleLogout(): void {
  localStorage.removeItem(PBA_NATIVE_AUTH_TOKEN_KEY);
  localStorage.removeItem('xproof_native_auth_token'); // legacy, belt-and-suspenders
  localStorage.removeItem('nativeAuthToken');
  localStorage.removeItem('loginToken');
}
