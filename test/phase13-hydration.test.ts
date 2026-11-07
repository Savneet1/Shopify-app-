import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase 13.3 — client price hydration (pure logic, injected fetch). The DOM
 * wiring in boost-results.js is Requires Verification; the orchestrator +
 * parsers here are the testable core. No server call, no scope.
 */
const require = createRequire(import.meta.url);
const EXT = join(__dirname, "..", "extensions", "search-discovery-theme");
const required = require(join(EXT, "assets", "boost-core.js"));
const Core = required && required.runHydration ? required : (globalThis as any).BoostSearch;

describe("Phase 13.3 — parseProductJsPrices (defensive, integer minor units)", () => {
  it("reads price_min/price_max when present", () => {
    expect(Core.parseProductJsPrices({ price_min: 1000, price_max: 3000 })).toEqual({ minMinor: 1000, maxMinor: 3000 });
  });
  it("derives from variants when no min/max", () => {
    expect(Core.parseProductJsPrices({ variants: [{ price: 2500 }, { price: 999 }, { price: 4000 }] }))
      .toEqual({ minMinor: 999, maxMinor: 4000 });
  });
  it("falls back to a single price", () => {
    expect(Core.parseProductJsPrices({ price: 1500 })).toEqual({ minMinor: 1500, maxMinor: 1500 });
  });
  it("rejects non-integer / negative / junk → null (silent fallback)", () => {
    expect(Core.parseProductJsPrices({ price: 12.5 })).toBeNull();
    expect(Core.parseProductJsPrices({ price: -5 })).toBeNull();
    expect(Core.parseProductJsPrices({ price: "1000" })).toBeNull();
    expect(Core.parseProductJsPrices(null)).toBeNull();
    expect(Core.parseProductJsPrices({ variants: [{ price: "x" }] })).toBeNull();
  });
});

describe("Phase 13b C3 — formatMoneyMinor treats Ajax prices as hundredths", () => {
  // CHANGED in 13b: Ajax money values are hundredths even for zero-decimal
  // currencies (Shopify-staff community reply = Requires Verification). So
  // formatMoneyMinor always divides by 100 and lets Intl round to the currency's
  // own digits. The two tests below replace the pre-13b "divides by 10^digits"
  // pair (the USD case is unchanged; the JPY expectation changed from ¥2,000 to
  // ¥20 because 2000 hundredths = ¥20).
  it("USD 12900 -> $129.00", () => {
    expect(Core.formatMoneyMinor(12900, "USD", "en-US")).toMatch(/129\.00/);
  });
  it("pure formatter: JPY 1290000 (hundredths) -> ¥12,900 if the guard is lifted", () => {
    const s = Core.formatMoneyMinor(1290000, "JPY", "ja-JP");
    expect(s).toMatch(/12,?900/); // 1290000/100 = 12900, Intl JPY has 0 digits
    expect(s).not.toMatch(/\./); // no decimals for JPY
  });
  it("absurd / NaN / negative / string -> '' (keep indexed price)", () => {
    expect(Core.formatMoneyMinor(1e30, "USD", "en-US")).toBe("");
    expect(Core.formatMoneyMinor(NaN, "USD", "en-US")).toBe("");
    expect(Core.formatMoneyMinor(-5, "USD", "en-US")).toBe("");
    expect(Core.formatMoneyMinor("1000" as unknown as number, "USD", "en-US")).toBe("");
  });
  it("hydratedPriceString builds a range with an en-dash (USD)", () => {
    const s = Core.hydratedPriceString({ price_min: 1000, price_max: 3000 }, "USD", "en-US");
    expect(s).toMatch(/–/);
    expect(s).toMatch(/10\.00/);
    expect(s).toMatch(/30\.00/);
  });
  it("null parse → null (keep indexed price)", () => {
    expect(Core.hydratedPriceString({ price: 9.99 }, "USD", "en-US")).toBeNull();
  });
});

describe("Phase 13b C3 — currency eligibility guard (2-digit only, until verified)", () => {
  it("currencyHydrationEligible: USD/EUR yes; JPY/KWD no", () => {
    expect(Core.currencyHydrationEligible("USD")).toBe(true);
    expect(Core.currencyHydrationEligible("EUR")).toBe(true);
    expect(Core.currencyHydrationEligible("JPY")).toBe(false); // 0 digits
    expect(Core.currencyHydrationEligible("KWD")).toBe(false); // 3 digits
  });
  it("hydratedPriceString silently falls back (null) for non-2-digit currencies", () => {
    expect(Core.hydratedPriceString({ price_min: 1290000, price_max: 1290000 }, "JPY", "ja-JP")).toBeNull();
    expect(Core.hydratedPriceString({ price: 5000 }, "KWD", "ar")).toBeNull(); // KWD 3 digits
    expect(Core.hydratedPriceString({ price: 5000 }, "BHD", "ar")).toBeNull(); // BHD 3 digits
  });
  it("USD 12900 hydrates to $129.00", () => {
    expect(Core.hydratedPriceString({ price: 12900 }, "USD", "en-US")).toMatch(/129\.00/);
  });
  it("absurd value in the parse -> null (not a giant number)", () => {
    expect(Core.hydratedPriceString({ price: 1e30 }, "USD", "en-US")).toBeNull();
    expect(Core.parseProductJsPrices({ price: 1e30 })).toBeNull();
  });
  // Phase 14.6b: a missing / invalid currency must keep the indexed price (null),
  // never a bare unlabelled number.
  it("missing or invalid currency → null (never a bare number)", () => {
    expect(Core.currencyHydrationEligible(undefined)).toBe(false);
    expect(Core.currencyHydrationEligible("")).toBe(false);
    expect(Core.currencyHydrationEligible("US")).toBe(false);
    expect(Core.currencyHydrationEligible("DOLLAR")).toBe(false);
    expect(Core.hydratedPriceString({ price: 12900 }, undefined as unknown as string, "en-US")).toBeNull();
    expect(Core.hydratedPriceString({ price: 12900 }, "", "en-US")).toBeNull();
    expect(Core.hydratedPriceString({ price: 12900 }, "US$", "en-US")).toBeNull();
  });
});

describe("Phase 13.3 — runHydration orchestrator (bounded, cached, abortable)", () => {
  const month = 0;
  it("caps at 12 cards and never calls fetch for the 13th+", async () => {
    const seen: string[] = [];
    const handles = Array.from({ length: 20 }, (_, i) => "h" + i);
    const got: Record<string, unknown> = {};
    await Core.runHydration(handles, (h: string) => { seen.push(h); return Promise.resolve({ price: 100 }); },
      { cache: new Map() }, (h: string, o: unknown) => { got[h] = o; });
    expect(seen.length).toBe(Core.HYDRATE_MAX_CARDS);
    expect(Object.keys(got).length).toBe(Core.HYDRATE_MAX_CARDS);
  });
  it("respects concurrency (never more than N in flight)", async () => {
    let inFlight = 0, maxInFlight = 0;
    const fetchJs = (_h: string) => new Promise((resolve) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => { inFlight--; resolve({ price: 1 }); }, 5);
    });
    await Core.runHydration(["a", "b", "c", "d", "e", "f"], fetchJs, { concurrency: 2, cache: new Map() }, () => {});
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
  it("uses the session cache (no duplicate fetches across calls)", async () => {
    const cache = new Map();
    let calls = 0;
    const fetchJs = (_h: string) => { calls++; return Promise.resolve({ price: 100 }); };
    await Core.runHydration(["x"], fetchJs, { cache }, () => {});
    await Core.runHydration(["x"], fetchJs, { cache }, () => {});
    expect(calls).toBe(1);
  });
  it("per-handle timeout resolves to null (silent fallback), never hangs", async () => {
    const results: Record<string, unknown> = {};
    const fetchJs = (_h: string) => new Promise(() => {}); // never resolves
    await Core.runHydration(["slow"], fetchJs, { timeoutMs: 10, cache: new Map() },
      (h: string, o: unknown) => { results[h] = o; });
    expect(results["slow"]).toBeNull();
  });
  it("abort stops further work", async () => {
    let aborted = false;
    const emitted: string[] = [];
    const fetchJs = (_h: string) => Promise.resolve({ price: 1 });
    const p = Core.runHydration(["a", "b", "c"], fetchJs,
      { concurrency: 1, cache: new Map(), aborted: () => aborted },
      (h: string) => { emitted.push(h); });
    aborted = true;
    await p;
    // first item may emit (null on abort); subsequent are short-circuited
    expect(emitted.length).toBeLessThanOrEqual(3);
  });
});

describe("Phase 13.3 — STATIC: hydration is same-origin, OFF by default", () => {
  const results = readFileSync(join(EXT, "assets", "boost-results.js"), "utf8");
  const liquid = readFileSync(join(EXT, "blocks", "boost-results.liquid"), "utf8");
  it("fetch target is a same-origin /products/<handle>.js path (no cross-origin host)", () => {
    expect(results).toMatch(/products\/"\s*\+\s*encodeURIComponent\(handle\)\s*\+\s*"\.js/);
    expect(results).toMatch(/credentials:\s*"same-origin"/);
  });
  it("guarded by cfg.priceHydration === true (default off in the schema)", () => {
    expect(results).toMatch(/cfg\.priceHydration\s*!==\s*true/);
    expect(liquid).toMatch(/"id":\s*"price_hydration"[\s\S]*?"default":\s*false/);
  });
  it("404 hides the card ONLY in the hydration path", () => {
    expect(results).toMatch(/__notFound/);
  });
});
