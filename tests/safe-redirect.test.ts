import { describe, expect, it } from "vitest";
import { getSafeRedirectTo } from "../client/src/lib/safe-redirect";

describe("getSafeRedirectTo", () => {
  it("keeps an internal path and its query/hash", () => {
    expect(getSafeRedirectTo("/certify?source=landing#upload", "https://provebeforeact.com"))
      .toBe("/certify?source=landing#upload");
  });

  it("rejects external and protocol-relative URLs", () => {
    expect(getSafeRedirectTo("https://evil.example/phish", "https://provebeforeact.com"))
      .toBe("/dashboard");
    expect(getSafeRedirectTo("//evil.example/phish", "https://provebeforeact.com"))
      .toBe("/dashboard");
  });

  it("falls back safely for missing or malformed destinations", () => {
    expect(getSafeRedirectTo(undefined, "https://provebeforeact.com")).toBe("/dashboard");
    expect(getSafeRedirectTo("not-a-path", "https://provebeforeact.com")).toBe("/dashboard");
  });
});