import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkParity } from "../scripts/check-locale-parity.mjs";

/*
 * Phase 11.8 — storefront extension static checks for the analytics emitter and
 * the per-block toggles. DOM behaviour (sendBeacon, sessionStorage) is Requires
 * Verification; the pure helpers are unit-tested in phase11-units via boost-core.
 */
const require = createRequire(import.meta.url);
const EXT = join(__dirname, "..", "extensions", "search-discovery-theme");
const required = require(join(EXT, "assets", "boost-core.js"));
const Core = required && required.cleanAnalyticsEvent ? required : (globalThis as any).BoostSearch;

describe("Phase 11 boost-core — analytics helpers (pure)", () => {
  it("newSessionId is bounded [A-Za-z0-9_-] and reasonably long", () => {
    for (let i = 0; i < 50; i++) {
      const id = Core.newSessionId();
      expect(/^[A-Za-z0-9_-]{8,64}$/.test(id)).toBe(true);
    }
  });
  it("cleanAnalyticsEvent accepts valid, rejects bad enum/surface, trims fields", () => {
    expect(Core.cleanAnalyticsEvent({ eventType: "result_click", surface: "search_page", productGid: "gid://shopify/Product/5", position: 3 }))
      .toMatchObject({ eventType: "result_click", surface: "search_page", productGid: "gid://shopify/Product/5", position: 3 });
    expect(Core.cleanAnalyticsEvent({ eventType: "nope", surface: "search_page" })).toBeNull();
    expect(Core.cleanAnalyticsEvent({ eventType: "result_click", surface: "moon" })).toBeNull();
    expect(Core.cleanAnalyticsEvent({ eventType: "result_click", surface: "search_page", productGid: "gid://shopify/Variant/1" }).productGid).toBeUndefined();
    expect(Core.cleanAnalyticsEvent(null)).toBeNull();
    expect(Core.cleanAnalyticsEvent({ eventType: "search_performed", surface: "search_page", query: "x".repeat(500) }).query.length).toBe(200);
  });
});

describe("Phase 11 — analytics emitter glue (static)", () => {
  const glue = readFileSync(join(EXT, "assets", "boost-analytics.js"), "utf8");

  it("exists and is loaded by every emitting block", () => {
    expect(existsSync(join(EXT, "assets", "boost-analytics.js"))).toBe(true);
    for (const b of ["boost-results", "boost-predictive", "boost-recommendations", "boost-bundle"]) {
      const src = readFileSync(join(EXT, "blocks", b + ".liquid"), "utf8");
      expect(src.includes("boost-analytics.js"), b).toBe(true);
    }
  });

  it("renders no markup from data — never uses innerHTML", () => {
    expect(glue.includes("innerHTML")).toBe(false);
  });

  it("CONSENT is checked before ANY sessionStorage access (fail-closed)", () => {
    expect(glue.includes("consentAllowsAnalytics")).toBe(true);
    // every sessionStorage line must sit inside a function that returned early
    // unless consentOk(); assert the guard appears before the first storage use.
    const firstConsent = glue.indexOf("consentOk()");
    const firstStorage = glue.indexOf("window.sessionStorage");
    expect(firstConsent).toBeGreaterThan(-1);
    expect(firstStorage).toBeGreaterThan(-1);
    expect(firstConsent).toBeLessThan(firstStorage);
    // sessionId() guards with "if (!consentOk()) { clearSession(); return null; }"
    expect(/function sessionId\(\)\s*\{\s*if \(!consentOk\(\)\)/.test(glue)).toBe(true);
  });

  it("sends via sendBeacon/fetch keepalive to the analytics-event endpoint", () => {
    expect(glue.includes("sendBeacon")).toBe(true);
    expect(glue.includes("/analytics-event")).toBe(true);
    expect(glue.includes("keepalive")).toBe(true);
  });
});

describe("Phase 11 — per-block analytics toggle uses the schema-default form", () => {
  // analytics defaults to FALSE in every block, so it must use the `== true` form.
  for (const b of ["boost-results", "boost-predictive", "boost-recommendations", "boost-bundle"]) {
    it(`${b}: analytics config uses {% if ... == true %}`, () => {
      const src = readFileSync(join(EXT, "blocks", b + ".liquid"), "utf8");
      expect(/"analytics":\s*\{%\s*if\s+block\.settings\.analytics\s*==\s*true\s*%\}true\{%\s*else\s*%\}false\{%\s*endif\s*%\}/.test(src), b).toBe(true);
      // and the schema declares it default false
      expect(/"id":\s*"analytics"[\s\S]{0,160}"default":\s*false/.test(src), b + " schema default").toBe(true);
    });
  }

  it("locale parity holds across all extension locales (incl. the analytics key)", () => {
    const { ok, problems } = checkParity(join(EXT, "locales"));
    if (!ok) console.error(JSON.stringify(problems));
    expect(ok).toBe(true);
  });
});
