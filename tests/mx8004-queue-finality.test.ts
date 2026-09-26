import { afterEach, describe, expect, it, vi } from "vitest";
import { assessMx8004Finality } from "../server/txQueue";
import { getMx8004TransactionFinality } from "../server/mx8004";

const hash = "a".repeat(64);
const active = { step: 0, hash, broadcastAt: "2026-01-01T00:00:00.000Z" };

afterEach(() => vi.unstubAllGlobals());

describe("MX-8004 queue finality", () => {
  it("does not advance a pending broadcast, and requires recovery after 30 minutes", () => {
    expect(assessMx8004Finality(active, "pending", Date.parse(active.broadcastAt) + 29 * 60_000)).toBe("pending");
    expect(assessMx8004Finality(active, "pending", Date.parse(active.broadcastAt) + 30 * 60_000)).toBe("recovery_required");
    expect(assessMx8004Finality(active, "confirmed")).toBe("confirmed");
    expect(assessMx8004Finality(active, "failed")).toBe("failed");
    expect(assessMx8004Finality({ ...active, broadcastAt: "invalid" }, "pending")).toBe("recovery_required");
  });

  it("requires successful inclusion metadata, not just gateway acceptance", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ txHash: hash, status: "pending" }))
      .mockResolvedValueOnce(Response.json({ txHash: hash, status: "success" }))
      .mockResolvedValueOnce(Response.json({ txHash: hash, status: "success", round: 1, blockNonce: 10 }))
      .mockResolvedValueOnce(Response.json({ txHash: hash, status: "fail" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getMx8004TransactionFinality(hash)).toBe("pending");
    expect(await getMx8004TransactionFinality(hash)).toBe("pending");
    expect(await getMx8004TransactionFinality(hash)).toBe("pending");
    expect(await getMx8004TransactionFinality(hash)).toBe("confirmed");
    expect(await getMx8004TransactionFinality(hash)).toBe("failed");
  });

  it("does not treat an upstream error or hash mismatch as finality", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ txHash: "b".repeat(64), status: "success", round: 1, blockNonce: 1 })));
    await expect(getMx8004TransactionFinality(hash)).rejects.toThrow("503");
    await expect(getMx8004TransactionFinality(hash)).rejects.toThrow("mismatched hash");
  });
});