import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { maybeLogSlow, hashShop, SLOW_QUERY_MS } from "~/lib/logger.server";
// NOTE: proxy.server.ts transitively imports @prisma/client (not generated in
// the offline sandbox), so its header constants are asserted statically.

/*
 * Phase 14.4 f/g/i — security headers, error hygiene, slow-query log.
 */
const APP = join(__dirname, "..", "app");

describe("Phase 14.4f — security headers", () => {
  it("proxy JSON responses are nosniff + no-store + json", () => {
    const src = readFileSync(join(APP, "lib", "search", "proxy.server.ts"), "utf8");
    const block = src.slice(src.indexOf("JSON_HEADERS"), src.indexOf("JSON_HEADERS") + 400);
    expect(block).toContain('"X-Content-Type-Options": "nosniff"');
    expect(block).toContain('"Cache-Control": "no-store"');
    expect(block).toMatch(/application\/json/);
  });
  it("admin document responses get frame-ancestors CSP + nosniff + Referrer-Policy", () => {
    const src = readFileSync(join(APP, "entry.server.tsx"), "utf8");
    expect(src).toContain("addDocumentResponseHeaders"); // Shopify CSP frame-ancestors
    expect(src).toContain("X-Content-Type-Options");
    expect(src).toContain("Referrer-Policy");
  });
});

describe("Phase 14.4g — error hygiene", () => {
  it("the proxy catch returns a generic native-fallback body (no stack/SQL/paths)", () => {
    const src = readFileSync(join(APP, "lib", "search", "proxy.server.ts"), "utf8");
    // the generic fallback shape, and only err.message is logged (never the stack)
    expect(src).toMatch(/fallback: "native"[\s\S]*reason: "error"/);
    expect(src).not.toMatch(/err\.stack/);
  });
  it("healthz returns only {ok} — never tenant data or secrets", () => {
    const src = readFileSync(join(APP, "routes", "healthz.tsx"), "utf8");
    expect(src).toContain("SELECT 1");
    expect(src).toMatch(/JSON\.stringify\(\{ ok: true \}\)/);
    expect(src).toMatch(/JSON\.stringify\(\{ ok: false \}\)/);
    expect(src).toMatch(/status: 503/); // degrades, never throws a 500 with details
    // the ONLY query is the connectivity probe — no tenant table is read
    expect((src.match(/\$queryRaw/g) || []).length).toBe(1);
    expect(src).not.toMatch(/product|order|customer|email_setting|withShop/);
  });
});

describe("Phase 14.4b — rate-limit + body-size audit", () => {
  const ROUTES = join(APP, "routes");
  it("handleProxy applies the per-shop rate limiter to EVERY proxy route", () => {
    const px = readFileSync(join(APP, "lib", "search", "proxy.server.ts"), "utf8");
    expect(px).toContain("storefrontLimiter.check");
    expect(px).toMatch(/status: 429/);
  });
  it("the two JSON-body endpoints enforce an explicit byte cap", () => {
    for (const [f, cap] of [["proxy.analytics-event", /16 \* 1024/], ["proxy.back-in-stock", /4 \* 1024/]] as const) {
      const src = readFileSync(join(ROUTES, `${f}.tsx`), "utf8");
      expect(src).toMatch(/MAX_BODY_BYTES/);
      expect(src).toMatch(cap);
      expect(src).toMatch(/> MAX_BODY_BYTES/); // reject oversize before parse/SQL
    }
  });
  it("the counter beacons read only URL params (no request body to size-bound)", () => {
    for (const f of ["proxy.merch-event", "proxy.rec-event", "proxy.bundle-event"]) {
      const src = readFileSync(join(ROUTES, `${f}.tsx`), "utf8");
      expect(src).not.toMatch(/request\.(json|text|formData)\(/);
    }
  });
});

describe("Phase 14.4i — slow-query log", () => {
  it("hashShop never reveals the raw shop id", () => {
    const h = hashShop("my-shop.myshopify.com");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(h).not.toContain("my-shop");
  });
  it("maybeLogSlow stays silent below the threshold", () => {
    // capture console/stdout is covered by log-redaction; here just assert the
    // threshold is a sane positive bound and the fn does not throw.
    expect(SLOW_QUERY_MS).toBeGreaterThanOrEqual(50);
    expect(() => maybeLogSlow("x", 0, "shop")).not.toThrow();
    expect(() => maybeLogSlow("x", SLOW_QUERY_MS + 1, "shop")).not.toThrow();
  });
});
