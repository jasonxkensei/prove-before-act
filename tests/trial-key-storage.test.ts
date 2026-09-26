import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredTrialKey,
  markTrialKeyHandled,
  readStoredTrialKey,
  storeTrialKey,
} from "../client/src/lib/trial-key-storage";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("trial key session storage", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { sessionStorage: createStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores a valid one-time key within the same browser tab", () => {
    storeTrialKey("pm_trial-secret", "audit-agent");

    expect(readStoredTrialKey()).toEqual({
      apiKey: "pm_trial-secret",
      agentName: "audit-agent",
      handled: false,
    });
  });

  it("tracks acknowledgement without deleting the key", () => {
    storeTrialKey("pm_trial-secret", "audit-agent");
    markTrialKeyHandled();

    expect(readStoredTrialKey()?.handled).toBe(true);
  });

  it("clears every stored trial-key field", () => {
    storeTrialKey("pm_trial-secret", "audit-agent");
    clearStoredTrialKey();

    expect(readStoredTrialKey()).toBeNull();
  });

  it("never persists malformed credentials", () => {
    storeTrialKey("not-a-pm-key", "audit-agent");

    expect(readStoredTrialKey()).toBeNull();
  });

  it("never crashes the landing when browser policy blocks storage", () => {
    const blockedStorage = {
      getItem: () => { throw new DOMException("Blocked", "SecurityError"); },
      setItem: () => { throw new DOMException("Blocked", "SecurityError"); },
      removeItem: () => { throw new DOMException("Blocked", "SecurityError"); },
    };
    vi.stubGlobal("window", { sessionStorage: blockedStorage });

    expect(readStoredTrialKey()).toBeNull();
    expect(() => storeTrialKey("pm_trial-secret", "audit-agent")).not.toThrow();
    expect(() => markTrialKeyHandled()).not.toThrow();
    expect(() => clearStoredTrialKey()).not.toThrow();
  });
});