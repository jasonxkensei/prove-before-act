/**
 * Verifies that handleLogout (the belt-and-suspenders logout path shared by
 * wallet-login-modal.tsx and useWalletAuth.ts) removes all three token key
 * variants from localStorage so no auth material lingers after sign-out.
 *
 * Keys under test:
 *   pba_native_auth_token     — primary key (PBA_NATIVE_AUTH_TOKEN_KEY)
 *   xproof_native_auth_token  — legacy pre-rebrand key (compatibility identifier)
 *   nativeAuthToken           — legacy key written by older app versions
 *   loginToken                — legacy key written by older app versions
 *
 * The test imports the real production functions from @/lib/auth-storage
 * (not an inline copy) so any change to the implementation is immediately
 * reflected here.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  handleLogout,
  PBA_NATIVE_AUTH_TOKEN_KEY,
} from "@/lib/auth-storage";

// ---------------------------------------------------------------------------
// Minimal localStorage mock (Map-backed, matches the Web Storage API surface
// used by handleLogout).
// ---------------------------------------------------------------------------

function makeMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    key(index: number): string | null {
      return [...store.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
}

describe("handleLogout — localStorage token cleanup", () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = makeMockStorage();
    // Replace the global localStorage with our mock for the duration of each test.
    vi.stubGlobal("localStorage", mockStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes pba_native_auth_token (primary key) after logout", () => {
    localStorage.setItem(PBA_NATIVE_AUTH_TOKEN_KEY, "tok.primary.abc123");
    handleLogout();
    expect(localStorage.getItem(PBA_NATIVE_AUTH_TOKEN_KEY)).toBeNull();
  });

  it("removes xproof_native_auth_token (legacy pre-rebrand key) after logout", () => {
    localStorage.setItem("xproof_native_auth_token", "tok.legacy.prebrand");
    handleLogout();
    expect(localStorage.getItem("xproof_native_auth_token")).toBeNull();
  });

  it("removes nativeAuthToken (legacy key) after logout", () => {
    localStorage.setItem("nativeAuthToken", "tok.legacy.nativeAuthToken");
    handleLogout();
    expect(localStorage.getItem("nativeAuthToken")).toBeNull();
  });

  it("removes loginToken (legacy key) after logout) after logout", () => {
    localStorage.setItem("loginToken", "tok.legacy.loginToken");
    handleLogout();
    expect(localStorage.getItem("loginToken")).toBeNull();
  });

  it("removes all key variants simultaneously when all are present", () => {
    localStorage.setItem(PBA_NATIVE_AUTH_TOKEN_KEY, "tok.primary");
    localStorage.setItem("xproof_native_auth_token", "tok.prebrand");
    localStorage.setItem("nativeAuthToken", "tok.native");
    localStorage.setItem("loginToken", "tok.login");

    handleLogout();

    expect(localStorage.getItem(PBA_NATIVE_AUTH_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem("xproof_native_auth_token")).toBeNull();
    expect(localStorage.getItem("nativeAuthToken")).toBeNull();
    expect(localStorage.getItem("loginToken")).toBeNull();
  });

  it("leaves unrelated localStorage keys untouched", () => {
    localStorage.setItem("walletAddress", "erd1abc");
    localStorage.setItem(PBA_NATIVE_AUTH_TOKEN_KEY, "tok.primary");

    handleLogout();

    expect(localStorage.getItem("walletAddress")).toBe("erd1abc");
  });

  it("is idempotent — calling twice does not throw", () => {
    localStorage.setItem(PBA_NATIVE_AUTH_TOKEN_KEY, "tok.primary");
    expect(() => {
      handleLogout();
      handleLogout();
    }).not.toThrow();
    expect(localStorage.getItem(PBA_NATIVE_AUTH_TOKEN_KEY)).toBeNull();
  });

  it("primary key constant matches the string literal 'pba_native_auth_token'", () => {
    // Guards against a silent rename of the exported constant.
    expect(PBA_NATIVE_AUTH_TOKEN_KEY).toBe("pba_native_auth_token");
  });
});
