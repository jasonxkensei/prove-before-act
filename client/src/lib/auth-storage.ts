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
export const XPROOF_NATIVE_AUTH_TOKEN_KEY = 'xproof_native_auth_token';

/**
 * Belt-and-suspenders logout cleanup.
 *
 * Removes all three token key variants that may be present in localStorage:
 *   - xproof_native_auth_token  (primary key, written by wallet-login-modal)
 *   - nativeAuthToken           (legacy key, written by older app versions)
 *   - loginToken                (legacy key, written by older app versions)
 *
 * The sync path (syncAndRedirect in wallet-login-modal.tsx) already removes
 * these on a successful login cycle. handleLogout is the authoritative
 * fallback for sign-out and for any edge case where that cleanup was skipped
 * (e.g. an older tab still holding the key, or a failed sync).
 */
export function handleLogout(): void {
  localStorage.removeItem(XPROOF_NATIVE_AUTH_TOKEN_KEY);
  localStorage.removeItem('nativeAuthToken');
  localStorage.removeItem('loginToken');
}
