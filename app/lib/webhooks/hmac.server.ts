import crypto from "node:crypto";

/**
 * Shopify signs webhooks with a base64 HMAC-SHA256 of the RAW request body,
 * keyed by the app's client secret, in the `X-Shopify-Hmac-Sha256` header.
 *
 * In the React Router template `authenticate.webhook(request)` performs this
 * check for you. This standalone verifier is used for defence-in-depth at the
 * edge and is directly unit-testable. Requirement: return 401 on mismatch.
 */
export function computeShopifyHmac(
  rawBody: Buffer | string,
  secret: string,
): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function verifyShopifyWebhookHmac(
  rawBody: Buffer | string,
  hmacHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!hmacHeader || !secret) return false;
  const expected = Buffer.from(computeShopifyHmac(rawBody, secret));
  const provided = Buffer.from(hmacHeader);
  // Length check first: timingSafeEqual throws on length mismatch.
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

export function sha256Hex(raw: Buffer | string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
