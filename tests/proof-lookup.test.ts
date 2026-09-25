import { describe, expect, it } from "vitest";
import { parsePublicProofId } from "../client/src/lib/proof-lookup";

const origin = "https://app.replit.dev";
const id = "daa18cee-aa22-4a01-a2c7-44bddb481a60";

describe("public proof lookup", () => {
  it("accepts a proof ID or the app's own public proof link", () => {
    expect(parsePublicProofId(` ${id} `, origin)).toBe(id);
    expect(parsePublicProofId(`/proof/${id}?source=share`, origin)).toBe(id);
    expect(parsePublicProofId(`${origin}/proof/${id}`, origin)).toBe(id);
  });

  it("accepts canonical proof links without trusting unrelated hosts", () => {
    expect(parsePublicProofId(`https://provebeforeact.com/proof/${id}`, origin)).toBe(id);
    expect(parsePublicProofId(`provebeforeact.com/proof/${id}`, origin)).toBe(id);
    expect(parsePublicProofId(`https://provebeforeact.com.evil.test/proof/${id}`, origin)).toBeNull();
  });

  it("rejects malformed paths and non-proof content", () => {
    expect(parsePublicProofId("https://provebeforeact.com/standard", origin)).toBeNull();
    expect(parsePublicProofId("https://provebeforeact.com/proof/a%2Fb", origin)).toBeNull();
    expect(parsePublicProofId("javascript:alert(1)", origin)).toBeNull();
    expect(parsePublicProofId("", origin)).toBeNull();
  });
});