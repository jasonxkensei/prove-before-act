import { describe, expect, it } from "vitest";
import {
  CANONICAL_PUBLIC_ORIGIN,
  getCanonicalPublicUrl,
  isLegacyPublicHost,
} from "../server/publicOrigin";

describe("public domain canonicalization", () => {
  it("recognizes only retired public hosts as legacy", () => {
    expect(isLegacyPublicHost("xproof.app")).toBe(true);
    expect(isLegacyPublicHost("xproof.app.")).toBe(true);
    expect(isLegacyPublicHost("proofmint.replit.app")).toBe(true);
    expect(isLegacyPublicHost("provebeforeact.com")).toBe(false);
  });

  it("redirects legacy paths to the canonical origin while preserving paths and query strings", () => {
    expect(getCanonicalPublicUrl("/proof/example?format=json")).toBe(
      `${CANONICAL_PUBLIC_ORIGIN}/proof/example?format=json`,
    );
  });

  it("collapses retired discovery paths into the canonical paths in one redirect", () => {
    expect(getCanonicalPublicUrl("/.well-known/xproof.json?version=1")).toBe(
      `${CANONICAL_PUBLIC_ORIGIN}/.well-known/provebeforeact.json?version=1`,
    );
    expect(getCanonicalPublicUrl("/.well-known/xproof.md")).toBe(
      `${CANONICAL_PUBLIC_ORIGIN}/.well-known/provebeforeact.md`,
    );
  });

  it("does not turn malformed request targets into an open redirect", () => {
    expect(getCanonicalPublicUrl("//attacker.example")).toBe(
      `${CANONICAL_PUBLIC_ORIGIN}/`,
    );
    expect(getCanonicalPublicUrl("/\\attacker.example")).toBe(
      `${CANONICAL_PUBLIC_ORIGIN}/`,
    );
    expect(getCanonicalPublicUrl("/\\\\attacker.example")).toBe(
      `${CANONICAL_PUBLIC_ORIGIN}/`,
    );
  });
});