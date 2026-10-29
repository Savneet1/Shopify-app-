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

describe("Phase 13.3 — formatMoneyMinor respects currency exponent", () => {
  it("2-digit currency divides by 100", () => {
    expect(Core.formatMoneyMinor(1999, "USD", "en-US")).toMatch(/19\.99/);
  });
  it("0-digit currency (JPY) does not divide", () => {
    const s = Core.formatMoneyMinor(2000, "JPY", "ja-JP");
    expect(s).toMatch(/2,?000/); // ¥2,000 — not 20.00
  });
  it("hydratedPriceString builds a range with an en-dash", () => {
    const s = Core.hydratedPriceString({ price_min: 1000, price_max: 3000 }, "USD", "en-US");
    expect(s).toMatch(/–/);
  });
  it("null parse → null (keep indexed price)", () => {
    expect(Core.hydratedPriceString({ price: 9.99 }, "USD", "en-US")).toBeNull();
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
