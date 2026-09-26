import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/public-site-chrome", () => ({
  PublicSiteHeader: () => null,
  PublicSiteFooter: () => null,
}));
vi.mock("@/components/pba-mark", () => ({ PbaMark: () => null }));

import { VerificationVerdicts } from "../client/src/pages/verify";

describe("retired HTTP delivery verification marks", () => {
  const signedVerdicts = {
    why: { status: "verified", reason: "Signed WHY proof remains intact" },
    what: { status: "verified", reason: "Signed WHAT proof remains intact" },
    link: { status: "verified", reason: "Signed LINK proof remains intact" },
  };
  const compromisedRecord = {
    attestation: {
      profile: "pba-http-delivery-v1",
      verdicts: signedVerdicts,
      verified: true,
    },
    current: { status: "revoked" },
  };

  it("keeps historical verdict labels but shows no green status pills after revocation", () => {
    const markup = renderToStaticMarkup(createElement(VerificationVerdicts, {
      verdicts: compromisedRecord.attestation.verdicts,
      retired: compromisedRecord.current.status === "revoked",
    }));
    expect(markup.match(/verify-status--pending/g)).toHaveLength(3);
    expect(markup).not.toContain("verify-status--verified");
    expect(markup).not.toContain("verify-verdict--verified");
    expect(markup.match(/>verified</g)).toHaveLength(3);
    expect(markup).toContain("Signed WHY proof remains intact");
  });

  it("shows green only while the signed record is currently valid", () => {
    const markup = renderToStaticMarkup(createElement(VerificationVerdicts, {
      verdicts: signedVerdicts,
      retired: false,
    }));
    expect(markup.match(/verify-status--verified/g)).toHaveLength(3);
  });
});