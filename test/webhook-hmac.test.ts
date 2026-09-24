import { describe, expect, it } from "vitest";
import {
  computeShopifyHmac,
  verifyShopifyWebhookHmac,
} from "~/lib/webhooks/hmac.server";

const SECRET = "shpss_test_secret";
const BODY = JSON.stringify({ id: 123, topic: "customers/redact" });

describe("Shopify webhook HMAC verification", () => {
  it("accepts a correctly signed body", () => {
    const hmac = computeShopifyHmac(BODY, SECRET);
    expect(verifyShopifyWebhookHmac(BODY, hmac, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const hmac = computeShopifyHmac(BODY, SECRET);
    expect(verifyShopifyWebhookHmac(BODY + " ", hmac, SECRET)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const hmac = computeShopifyHmac(BODY, SECRET);
    expect(verifyShopifyWebhookHmac(BODY, hmac, "other_secret")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyShopifyWebhookHmac(BODY, null, SECRET)).toBe(false);
    expect(verifyShopifyWebhookHmac(BODY, undefined, SECRET)).toBe(false);
  });

  it("does not throw on a length-mismatched signature", () => {
    expect(() =>
      verifyShopifyWebhookHmac(BODY, "too-short", SECRET),
    ).not.toThrow();
    expect(verifyShopifyWebhookHmac(BODY, "too-short", SECRET)).toBe(false);
  });
});
