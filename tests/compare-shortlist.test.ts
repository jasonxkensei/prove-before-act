/**
 * Unit tests for the comparison shortlist sessionStorage round-trip.
 *
 * These tests import SHORTLIST_KEY, readShortlist, writeShortlist, and
 * clearShortlist directly from the production module used by leaderboard.tsx.
 * Any rename of SHORTLIST_KEY or change to the JSON format is therefore
 * caught automatically — the test cannot silently pass with a stale copy.
 *
 * Three describe blocks covering the three "Done looks like" scenarios:
 *
 * 1. Restore on reload — wallets written before a simulated hard refresh are
 *    still present when readShortlist() (the lazy initializer) runs again.
 * 2. Clear on Compare  — clearShortlist() (called by handleCompare before
 *    navigation) removes the key; the next readShortlist() returns an empty Set.
 * 3. Clear on Clear    — clearShortlist() (called by the Clear button) removes
 *    the key; the next readShortlist() also returns an empty Set.
 *
 * A lightweight MockStorage (satisfies Pick<Storage, "getItem"|"setItem"|"removeItem">)
 * is passed explicitly to each helper so that the tests run in Node without a
 * browser environment, while still exercising the real module-level constants
 * and logic — not a duplicated copy.
 *
 * Edge-cases:
 *   - Missing key → empty Set (no error)
 *   - Malformed JSON → empty Set (swallowed, not thrown)
 *   - Non-array JSON value → empty Set
 *   - Empty array → empty Set
 *   - Single wallet round-trips correctly
 *   - Max shortlist (6 wallets) round-trips without truncation
 *   - Other storage keys are unaffected by clearShortlist()
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SHORTLIST_KEY,
  readShortlist,
  writeShortlist,
  clearShortlist,
} from "../client/src/lib/compare-shortlist";

// ─── Minimal storage mock ─────────────────────────────────────────────────────

class MockStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private store: Map<string, string> = new Map();
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

let storage: MockStorage;
beforeEach(() => { storage = new MockStorage(); });

// ─── Sanity: SHORTLIST_KEY is a non-empty string (catches renames) ────────────

it("SHORTLIST_KEY is a non-empty string exported from the production module", () => {
  expect(typeof SHORTLIST_KEY).toBe("string");
  expect(SHORTLIST_KEY.length).toBeGreaterThan(0);
});

// ── 1. Restore on reload ──────────────────────────────────────────────────────

describe("Restore on reload (simulated browser refresh within same tab)", () => {
  it("restores a single wallet after write → read", () => {
    writeShortlist(new Set(["erd1abc"]), storage);
    expect(readShortlist(storage)).toEqual(new Set(["erd1abc"]));
  });

  it("restores three wallets after write → read", () => {
    const wallets = new Set(["erd1aaa", "erd1bbb", "erd1ccc"]);
    writeShortlist(wallets, storage);
    expect(readShortlist(storage)).toEqual(wallets);
  });

  it("restores the maximum shortlist (6 wallets) without truncation", () => {
    const wallets = new Set(["erd1a", "erd1b", "erd1c", "erd1d", "erd1e", "erd1f"]);
    writeShortlist(wallets, storage);
    const restored = readShortlist(storage);
    expect(restored.size).toBe(6);
    for (const w of wallets) expect(restored.has(w)).toBe(true);
  });

  it("returns empty Set when nothing was written (missing key)", () => {
    expect(readShortlist(storage).size).toBe(0);
  });

  it("returns empty Set for an empty JSON array", () => {
    storage.setItem(SHORTLIST_KEY, JSON.stringify([]));
    expect(readShortlist(storage).size).toBe(0);
  });

  it("returns empty Set and does not throw for malformed JSON", () => {
    storage.setItem(SHORTLIST_KEY, "{not valid json[[");
    expect(() => readShortlist(storage)).not.toThrow();
    expect(readShortlist(storage).size).toBe(0);
  });

  it("returns empty Set and does not throw when value is a JSON object (not an array)", () => {
    storage.setItem(SHORTLIST_KEY, JSON.stringify({ wallet: "erd1abc" }));
    expect(() => readShortlist(storage)).not.toThrow();
    expect(readShortlist(storage).size).toBe(0);
  });

  it("is order-stable: every written wallet is present after read", () => {
    const original = ["erd1x", "erd1y", "erd1z"];
    writeShortlist(new Set(original), storage);
    const restored = readShortlist(storage);
    for (const w of original) expect(restored.has(w)).toBe(true);
    expect(restored.size).toBe(original.length);
  });
});

// ── 2. Clear on Compare ───────────────────────────────────────────────────────

describe("Clear on Compare — clearShortlist() called by handleCompare before navigate", () => {
  it("removes the key so readShortlist() returns empty Set on the next mount", () => {
    writeShortlist(new Set(["erd1aaa", "erd1bbb"]), storage);
    clearShortlist(storage);
    expect(readShortlist(storage).size).toBe(0);
  });

  it("does not throw when called on already-empty storage", () => {
    expect(() => clearShortlist(storage)).not.toThrow();
  });

  it("leaves other storage keys untouched", () => {
    storage.setItem("some_other_key", "value");
    writeShortlist(new Set(["erd1aaa"]), storage);
    clearShortlist(storage);
    expect(storage.getItem("some_other_key")).toBe("value");
  });
});

// ── 3. Clear on Clear button ──────────────────────────────────────────────────

describe("Clear on Clear button — clearShortlist() + setSelectedWallets(new Set())", () => {
  it("removes the SHORTLIST_KEY from storage", () => {
    writeShortlist(new Set(["erd1aaa", "erd1bbb"]), storage);
    clearShortlist(storage);
    expect(storage.getItem(SHORTLIST_KEY)).toBeNull();
  });

  it("does not throw when storage is already empty", () => {
    expect(() => clearShortlist(storage)).not.toThrow();
  });

  it("readShortlist() returns empty Set after clearShortlist()", () => {
    writeShortlist(new Set(["erd1xyz"]), storage);
    clearShortlist(storage);
    expect(readShortlist(storage).size).toBe(0);
  });
});
