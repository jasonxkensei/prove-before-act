/**
 * Unit tests confirming the comparison shortlist is hard-capped at SHORTLIST_MAX
 * wallets and cannot grow beyond the limit via repeated toggle calls.
 *
 * These tests import `toggleWallet`, `SHORTLIST_MAX`, `writeShortlist`, and
 * `readShortlist` directly from the production module used by leaderboard.tsx.
 * Any change to the cap constant or toggle logic is therefore caught automatically.
 *
 * Four describe blocks mirror the three "Done looks like" items from task #337:
 *
 * 1. toggleWallet cap — a 7th toggle call is a no-op; the Set stays at 6.
 * 2. sessionStorage cap — the stored JSON array has at most 6 elements after
 *    repeated toggle calls, including the 7th attempt.
 * 3. Deselect still works at 6 — removing a wallet at full capacity succeeds.
 * 4. SHORTLIST_MAX constant — exported value equals 6 (catches accidental renames
 *    or value changes that would silently break the UI disabled guard).
 *
 * A lightweight MockStorage satisfies Pick<Storage, "getItem"|"setItem"|"removeItem">
 * so tests run in Node without a browser environment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SHORTLIST_KEY,
  SHORTLIST_MAX,
  toggleWallet,
  writeShortlist,
  readShortlist,
} from "../client/src/lib/compare-shortlist";

// ─── Minimal storage mock ──────────────────────────────────────────────────────

class MockStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private store: Map<string, string> = new Map();
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

// ─── Shared fixtures ───────────────────────────────────────────────────────────

/** Six distinct wallet addresses — the maximum shortlist size. */
const SIX_WALLETS = [
  "erd1wallet001",
  "erd1wallet002",
  "erd1wallet003",
  "erd1wallet004",
  "erd1wallet005",
  "erd1wallet006",
];

/** A seventh wallet that should never make it into a full shortlist. */
const SEVENTH_WALLET = "erd1wallet007";

let storage: MockStorage;
beforeEach(() => { storage = new MockStorage(); });

// ── 1. SHORTLIST_MAX constant sanity ──────────────────────────────────────────

describe("SHORTLIST_MAX constant", () => {
  it("equals 6 — the documented UI cap", () => {
    expect(SHORTLIST_MAX).toBe(6);
  });

  it("is a positive integer (not 0, not negative)", () => {
    expect(Number.isInteger(SHORTLIST_MAX)).toBe(true);
    expect(SHORTLIST_MAX).toBeGreaterThan(0);
  });
});

// ── 2. toggleWallet cap enforcement ───────────────────────────────────────────

describe("toggleWallet — 7th wallet toggle is a no-op", () => {
  it("returns a Set of exactly SHORTLIST_MAX after the 6th toggle", () => {
    let wallets: Set<string> = new Set();
    for (const w of SIX_WALLETS) {
      wallets = toggleWallet(wallets, w);
    }
    expect(wallets.size).toBe(SHORTLIST_MAX);
  });

  it("returns a Set still sized SHORTLIST_MAX after a 7th toggle on a new wallet", () => {
    let wallets: Set<string> = new Set(SIX_WALLETS);
    const after7 = toggleWallet(wallets, SEVENTH_WALLET);
    expect(after7.size).toBe(SHORTLIST_MAX);
  });

  it("does not add the 7th wallet to the returned Set", () => {
    let wallets: Set<string> = new Set(SIX_WALLETS);
    const after7 = toggleWallet(wallets, SEVENTH_WALLET);
    expect(after7.has(SEVENTH_WALLET)).toBe(false);
  });

  it("preserves all original 6 wallets after a 7th toggle attempt", () => {
    let wallets: Set<string> = new Set(SIX_WALLETS);
    const after7 = toggleWallet(wallets, SEVENTH_WALLET);
    for (const w of SIX_WALLETS) {
      expect(after7.has(w)).toBe(true);
    }
  });

  it("returns a new Set instance even when the toggle is a cap no-op", () => {
    const wallets = new Set(SIX_WALLETS);
    const after7 = toggleWallet(wallets, SEVENTH_WALLET);
    expect(after7).not.toBe(wallets);
    expect(after7.size).toBe(SHORTLIST_MAX);
  });

  it("is still a no-op on the 8th, 9th, and 10th toggle attempts", () => {
    let wallets: Set<string> = new Set(SIX_WALLETS);
    for (const extra of [SEVENTH_WALLET, "erd1wallet008", "erd1wallet009"]) {
      wallets = toggleWallet(wallets, extra);
      expect(wallets.size).toBe(SHORTLIST_MAX);
      expect(wallets.has(extra)).toBe(false);
    }
  });
});

// ── 3. Deselect still works at capacity ───────────────────────────────────────

describe("toggleWallet — deselect works when shortlist is at capacity", () => {
  it("removes a wallet and brings size to SHORTLIST_MAX − 1", () => {
    const wallets = new Set(SIX_WALLETS);
    const after = toggleWallet(wallets, SIX_WALLETS[0]);
    expect(after.size).toBe(SHORTLIST_MAX - 1);
    expect(after.has(SIX_WALLETS[0])).toBe(false);
  });

  it("after deselect at 6, re-toggle of the same wallet adds it back (size back to 6)", () => {
    let wallets: Set<string> = new Set(SIX_WALLETS);
    wallets = toggleWallet(wallets, SIX_WALLETS[2]);   // remove → 5
    expect(wallets.size).toBe(5);
    wallets = toggleWallet(wallets, SIX_WALLETS[2]);   // re-add → 6
    expect(wallets.size).toBe(SHORTLIST_MAX);
    expect(wallets.has(SIX_WALLETS[2])).toBe(true);
  });

  it("after deselect at 6 a different wallet can now be added (size goes back to 6)", () => {
    let wallets: Set<string> = new Set(SIX_WALLETS);
    wallets = toggleWallet(wallets, SIX_WALLETS[0]);     // free up one slot → 5
    wallets = toggleWallet(wallets, SEVENTH_WALLET);     // fill slot → 6
    expect(wallets.size).toBe(SHORTLIST_MAX);
    expect(wallets.has(SEVENTH_WALLET)).toBe(true);
  });
});

// ── 4. sessionStorage cap (write → read round-trip) ──────────────────────────

describe("sessionStorage — JSON array has at most SHORTLIST_MAX elements", () => {
  it("writeShortlist of 6 wallets produces an array of exactly 6 when read back", () => {
    const full = new Set(SIX_WALLETS);
    writeShortlist(full, storage);
    const restored = readShortlist(storage);
    expect(restored.size).toBe(SHORTLIST_MAX);
  });

  it("sessionStorage after 7 toggle calls still contains exactly 6 wallets", () => {
    // Simulate the leaderboard component's React state machine:
    // each onCheckedChange calls setSelectedWallets(prev => toggleWallet(prev, w))
    // and a useEffect writes the result to sessionStorage.
    let state: Set<string> = new Set();
    for (const w of SIX_WALLETS) {
      state = toggleWallet(state, w);
    }
    writeShortlist(state, storage);   // useEffect write after 6th toggle

    // 7th checkbox click attempt — toggleWallet is the cap gate
    state = toggleWallet(state, SEVENTH_WALLET);
    writeShortlist(state, storage);   // useEffect write after 7th toggle attempt

    const stored = readShortlist(storage);
    expect(stored.size).toBe(SHORTLIST_MAX);
    expect(stored.has(SEVENTH_WALLET)).toBe(false);
  });

  it("the raw JSON array in storage has length <= SHORTLIST_MAX", () => {
    let state: Set<string> = new Set();
    for (const w of SIX_WALLETS) {
      state = toggleWallet(state, w);
    }
    state = toggleWallet(state, SEVENTH_WALLET); // no-op
    writeShortlist(state, storage);

    // Inspect the raw JSON to confirm the serialized array length
    const raw = storage.getItem(SHORTLIST_KEY);
    expect(raw).not.toBeNull();
    const arr: unknown[] = JSON.parse(raw!);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeLessThanOrEqual(SHORTLIST_MAX);
  });

  it("the raw JSON array never exceeds SHORTLIST_MAX even after many extra toggle attempts", () => {
    let state: Set<string> = new Set(SIX_WALLETS);

    // Attempt to add 4 more wallets beyond the cap
    for (const extra of [SEVENTH_WALLET, "erd1w8", "erd1w9", "erd1w10"]) {
      state = toggleWallet(state, extra);
    }
    writeShortlist(state, storage);

    const raw = storage.getItem(SHORTLIST_KEY);
    const arr: unknown[] = JSON.parse(raw!);
    expect(arr.length).toBeLessThanOrEqual(SHORTLIST_MAX);
  });
});
