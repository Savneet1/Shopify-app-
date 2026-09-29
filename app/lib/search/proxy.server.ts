import { authenticate } from "~/shopify.server";
import { resolveShopId } from "~/lib/tenant.server";
import { storefrontLimiter } from "./rate-limit";
import { FilterValidationError } from "./filters";
import { logger } from "~/lib/logger.server";

/**
 * Shared App Proxy request handling for the storefront search endpoints
 * (Phase 3.6).
 *
 * Security contract:
 *  - authenticate.public.appProxy(request) VERIFIES the Shopify proxy signature.
 *    An invalid/absent signature makes it throw a 400 Response, which we let
 *    propagate — tampered requests never reach the query layer.
 *  - The shop identity is taken from the SIGNATURE-VERIFIED session
 *    (session.shop), never from a raw ?shop query parameter. Because the shop
 *    parameter is part of the signed payload, a tampered ?shop invalidates the
 *    signature (400) rather than selecting another tenant.
 *  - shopId is resolved server-side and every query runs under withShop (RLS),
 *    so one shop's proxy request can only ever read its own catalog.
 *  - Responses are always JSON (application/json), never Liquid/HTML.
 *  - Per-shop rate limiting (Redis-free token bucket) protects the endpoint;
 *    over-limit requests get 429 with Retry-After.
 *  - No search queries are logged (only minimal, PII-free operational logs).
 */

export interface ProxyContext {
  shop: string;
  shopId: string;
  url: URL;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  // Proxy responses are per-shop and time-sensitive; let Shopify's proxy layer
  // and browsers cache very briefly at most.
  "Cache-Control": "no-store",
};

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    ...init,
    headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
  });
}

/**
 * Authenticate + rate-limit an App Proxy request, then run `handler` with the
 * verified tenant context. Returns a JSON Response. Any thrown Response from the
 * authenticator (invalid signature) propagates unchanged.
 */
export async function handleProxy(
  request: Request,
  handler: (ctx: ProxyContext) => Promise<unknown>,
): Promise<Response> {
  // Throws a 400 Response on invalid signature.
  const { session } = await authenticate.public.appProxy(request);

  // Valid signature but no offline session (app not fully installed / no token):
  // we cannot safely serve results — advise native fallback, HTTP 200.
  if (!session?.shop) {
    return jsonResponse({ fallback: "native", products: [], total: 0, reason: "no-session" });
  }

  const shop = session.shop;

  // Rate limit per verified shop.
  const decision = storefrontLimiter.check(shop);
  if (!decision.allowed) {
    return jsonResponse(
      { fallback: "native", products: [], total: 0, reason: "rate-limited" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) },
      },
    );
  }

  const shopId = await resolveShopId(shop);
  const url = new URL(request.url);

  try {
    const data = await handler({ shop, shopId, url });
    return jsonResponse(data);
  } catch (err) {
    // Malformed filter input -> clean 400 (client error), never a 500.
    if (err instanceof FilterValidationError) {
      return jsonResponse({ error: "invalid_filters", message: err.message }, { status: 400 });
    }
    // Never leak a bare 500 to the storefront: advise native fallback (200).
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "storefront proxy handler error",
    );
    return jsonResponse({ fallback: "native", products: [], total: 0, reason: "error" });
  }
}
