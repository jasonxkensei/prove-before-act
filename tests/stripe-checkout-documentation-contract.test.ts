import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("Stripe prepaid-pack public contract", () => {
  it("documents Stripe as additive and webhook-fulfilled", () => {
    const docs = [
      read("README.md"),
      read("README.zh.md"),
      read("docs/api-reference.md"),
      read("client/src/pages/docs.tsx"),
      read("server/routes/content.ts"),
      read("server/prerender.ts"),
    ].join("\n");
    expect(docs).toContain("/api/credits/stripe/checkout");
    expect(docs).toContain("/api/credits/stripe/status/");
    expect(docs).toMatch(/additional payment option|additional option|新增选项/i);
    expect(docs).toMatch(/signed Stripe webhook|签名验证.*Stripe webhook/i);
    expect(docs).toContain("USDC");
    expect(docs).toContain("x402");
    expect(docs).toContain("ACP");
    expect(docs).toContain("EGLD");
  });

  it("publishes both payment methods in package discovery", () => {
    const route = read("server/routes/credits.ts");
    expect(route).toContain('provider: "stripe"');
    expect(route).toContain('provider: "usdc_base"');
    expect(route).toContain("stripe_workflow");
  });

  it("keeps browser and machine Stripe discovery aliases explicit", () => {
    const stripeRoutes = read("server/routes/stripe-credits.ts");
    const appRoutes = read("client/src/App.tsx");
    const telemetry = read("server/conversion-telemetry.ts");
    expect(stripeRoutes).toContain('app.get("/checkout"');
    expect(stripeRoutes).toContain('"/api/billing", "/api/stripe", "/api/checkout"');
    expect(stripeRoutes).toContain('app.post([checkoutPath, "/api/checkout"]');
    expect(stripeRoutes).toContain("METHOD_NOT_ALLOWED");
    expect(appRoutes).toContain('<Route path="/billing" component={CreditsPage} />');
    expect(appRoutes).toContain('<Route path="/checkout"><Redirect to="/billing" /></Route>');
    expect(telemetry).toContain('req.path === "/api/checkout"');
  });
});
