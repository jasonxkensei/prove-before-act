import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children?: unknown; [key: string]: unknown }) =>
    createElement("a", { href, ...props }, children as never),
}));

import { PbaMark } from "../client/src/components/pba-mark";
import { PUBLIC_VERIFICATION_REFRESH_INTERVAL_MS } from "../client/src/hooks/visible-polling";

const greenRecord = {
  attestation: {
    verified: true,
    verdicts: {
      why: { status: "verified" },
      what: { status: "verified" },
      link: { status: "verified" },
    },
  },
  current: { status: "verified" },
};
const revokedRecord = {
  ...greenRecord,
  current: { status: "revoked" },
};

function response(body: unknown) {
  return { ok: true, json: async () => body };
}

describe("live PBA mark refresh", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let visibilityState: DocumentVisibilityState;
  const listeners = new Map<string, EventListenerOrEventListenerObject>();

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = "visible";
    listeners.clear();
    vi.stubGlobal("document", {
      get visibilityState() { return visibilityState; },
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
  });

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function segmentStrokes() {
    return renderer!.root
      .findAll((node) => node.props["data-segment"] !== undefined)
      .map((node) => node.props.stroke);
  }

  it("turns an already-open green mark neutral after the public record is revoked", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(greenRecord))
      .mockResolvedValueOnce(response(revokedRecord));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      renderer = TestRenderer.create(createElement(PbaMark, { id: "record-1" }));
      await Promise.resolve();
    });
    expect(segmentStrokes()).toEqual(Array(3).fill("var(--pba-verified)"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLIC_VERIFICATION_REFRESH_INTERVAL_MS);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(segmentStrokes()).toEqual(Array(3).fill("var(--pba-pending)"));
    expect(renderer!.root.findByProps({ className: "pba-mark__caption" }).children.join(""))
      .toContain("Record no longer current");
  });

  it("pauses while hidden and refreshes immediately when visible again", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(greenRecord))
      .mockResolvedValueOnce(response(revokedRecord));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      renderer = TestRenderer.create(createElement(PbaMark, { id: "record-1" }));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibilityState = "hidden";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLIC_VERIFICATION_REFRESH_INTERVAL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    const listener = listeners.get("visibilitychange");
    await act(async () => {
      if (typeof listener === "function") listener(new Event("visibilitychange"));
      else listener?.handleEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(segmentStrokes()).toEqual(Array(3).fill("var(--pba-pending)"));
  });
});