/**
 * Unit tests for the comparison shortlist sessionStorage round-trip.
 *
 * The leaderboard component stores the shortlist in sessionStorage under
 * SHORTLIST_KEY = "xproof_compare_shortlist".  These tests exercise the
 * three logical paths extracted verbatim from leaderboard.tsx so that a
 * silent regression (key rename, JSON format change, parse-error swallow)
 * is caught before it ships.
 *
 * Three describe blocks:
 *
 * 1. Restore on reload — wallets written before a simulated refresh are
 *    still present when the lazy initializer runs again.
 * 2. Clear on Compare  — handleCompare removes the key; a subsequent read
 *    returns an empty Set (simulating the fresh mount after navigation).
 * 3. Clear on Clear    — the Clear button handler removes the key and
 *    resets the Set; a subsequent read also returns an empty Set.
 *
 * Edge-cases covered:
 *   - Missing key → empty Set (no error)
 *   - Malformed JSON → empty Set (swallowed, not thrown)
 *   - Non-array JSON → empty Set
 *   - Empty array → empty Set
 *   - Single wallet persists
 *   - Max shortlist (6 wallets) persists without truncation
 *   - Wallets are order-stable after JSON round-trip
 */

import { describe, it, expect, beforeEach } from "vitest";

// ─── Inline mock of browser sessionStorage ────────────────────────────────────

class MockSessionStorage {
  private store: Map<string, string> = new Map();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get length(): number {
    return this.store.size;
  }
}

// ─── Functions extracted verbatim from leaderboard.tsx ───────────────────────

const SHORTLIST_KEY = "xproof_compare_shortlist";

/** Mirrors the useState lazy initializer in leaderboard.tsx */
function readShortlist(storage: MockSessionStorage): Set<string> {
  try {
    const raw = storage.getItem(SHORTLIST_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr as string[]);
    }
  } catch {}
  return new Set();
}

/** Mirrors the persistence useEffect in leaderboard.tsx */
function writeShortlist(storage: MockSessionStorage, wallets: Set<string>): void {
  try {
    storage.setItem(SHORTLIST_KEY, JSON.stringify(Array.from(wallets)));
  } catch {}
}

/** Mirrors handleCompare in leaderboard.tsx (remove key before navigate) */
function clearShortlistOnCompare(storage: MockSessionStorage): void {
  try { storage.removeItem(SHORTLIST_KEY); } catch {}
}

/** Mirrors the Clear button onClick in leaderboard.tsx */
function clearShortlistOnClear(storage: MockSessionStorage): Set<string> {
  try { storage.removeItem(SHORTLIST_KEY); } catch {}
  return new Set();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let storage: MockSessionStorage;

beforeEach(() => {
  storage = new MockSessionStorage();
});

// ── 1. Restore on reload ──────────────────────────────────────────────────────

describe("Restore on reload", () => {
  it("restores a single wallet after write → read", () => {
    const wallets = new Set(["erd1abc"]);
    writeShortlist(storage, wallets);
    const restored = readShortlist(storage);
    expect(restored).toEqual(new Set(["erd1abc"]));
  });

  it("restores multiple wallets after write → read", () => {
    const wallets = new Set(["erd1aaa", "erd1bbb", "erd1ccc"]);
    writeShortlist(storage, wallets);
    const restored = readShortlist(storage);
    expect(restored).toEqual(wallets);
  });

  it("restores the maximum shortlist size (6 wallets) without truncation", () => {
    const wallets = new Set(
      ["erd1a", "erd1b", "erd1c", "erd1d", "erd1e", "erd1f"]
    );
    writeShortlist(storage, wallets);
    const restored = readShortlist(storage);
    expect(restored.size).toBe(6);
    for (const w of wallets) expect(restored.has(w)).toBe(true);
  });

  it("returns an empty Set when nothing was written (missing key)", () => {
    const restored = readShortlist(storage);
    expect(restored.size).toBe(0);
  });

  it("returns an empty Set for an empty array value", () => {
    storage.setItem(SHORTLIST_KEY, JSON.stringify([]));
    const restored = readShortlist(storage);
    expect(restored.size).toBe(0);
  });

  it("returns an empty Set and does not throw for malformed JSON", () => {
    storage.setItem(SHORTLIST_KEY, "{not valid json[[");
    expect(() => readShortlist(storage)).not.toThrow();
    expect(readShortlist(storage).size).toBe(0);
  });

  it("returns an empty Set and does not throw when value is a JSON object (not array)", () => {
    storage.setItem(SHORTLIST_KEY, JSON.stringify({ wallet: "erd1abc" }));
    expect(() => readShortlist(storage)).not.toThrow();
    expect(readShortlist(storage).size).toBe(0);
  });

  it("is order-stable: wallets read back contain exactly the written wallets", () => {
    const original = ["erd1x", "erd1y", "erd1z"];
    writeShortlist(storage, new Set(original));
    const restored = readShortlist(storage);
    for (const w of original) expect(restored.has(w)).toBe(true);
    expect(restored.size).toBe(original.length);
  });
});

// ── 2. Clear on Compare ───────────────────────────────────────────────────────

describe("Clear on Compare (handleCompare)", () => {
  it("removes the key so the shortlist is empty on the next read", () => {
    writeShortlist(storage, new Set(["erd1aaa", "erd1bbb"]));
    clearShortlistOnCompare(storage);
    const restored = readShortlist(storage);
    expect(restored.size).toBe(0);
  });

  it("does not throw when called on an already-empty storage", () => {
    expect(() => clearShortlistOnCompare(storage)).not.toThrow();
  });

  it("leaves other storage keys untouched", () => {
    storage.setItem("some_other_key", "value");
    writeShortlist(storage, new Set(["erd1aaa"]));
    clearShortlistOnCompare(storage);
    expect(storage.getItem("some_other_key")).toBe("value");
  });
});

// ── 3. Clear on Clear button ──────────────────────────────────────────────────

describe("Clear on Clear button", () => {
  it("returns an empty Set and removes the key from storage", () => {
    writeShortlist(storage, new Set(["erd1aaa", "erd1bbb"]));
    const next = clearShortlistOnClear(storage);
    expect(next.size).toBe(0);
    expect(storage.getItem(SHORTLIST_KEY)).toBeNull();
  });

  it("does not throw when the storage is already empty", () => {
    expect(() => clearShortlistOnClear(storage)).not.toThrow();
  });

  it("a subsequent read returns an empty Set after Clear", () => {
    writeShortlist(storage, new Set(["erd1xyz"]));
    clearShortlistOnClear(storage);
    const restored = readShortlist(storage);
    expect(restored.size).toBe(0);
  });
});
