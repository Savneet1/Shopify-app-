import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase 8.1 H1 — consent gate for the A/B visitor token: pure
 * consentAllowsAnalytics behaviour + a STATIC guarantee that the storefront
 * never touches the boost_abt token outside a consent-guarded helper.
 */
const require = createRequire(import.meta.url);
const EXT = join(__dirname, "..", "extensions", "search-discovery-theme");
const req = require(join(EXT, "assets", "boost-core.js"));
const Core = req && req.consentAllowsAnalytics ? req : (globalThis as any).BoostSearch;

describe("Phase 8.1 — consentAllowsAnalytics (fail-closed, H1)", () => {
  it("true ONLY when a documented method returns strictly true", () => {
    expect(Core.consentAllowsAnalytics({ analyticsProcessingAllowed: () => true })).toBe(true);
    expect(Core.consentAllowsAnalytics({ userCanBeTracked: () => true })).toBe(true); // fallback
  });
  it("false for absent api, missing method, non-true, or throwing", () => {
    expect(Core.consentAllowsAnalytics(null)).toBe(false);
    expect(Core.consentAllowsAnalytics(undefined)).toBe(false);
    expect(Core.consentAllowsAnalytics({})).toBe(false); // no method
    expect(Core.consentAllowsAnalytics("nope" as any)).toBe(false);
    expect(Core.consentAllowsAnalytics({ analyticsProcessingAllowed: () => false })).toBe(false);
    expect(Core.consentAllowsAnalytics({ analyticsProcessingAllowed: () => "true" })).toBe(false); // non-boolean
    expect(Core.consentAllowsAnalytics({ analyticsProcessingAllowed: () => undefined })).toBe(false);
    expect(Core.consentAllowsAnalytics({ analyticsProcessingAllowed: () => { throw new Error("x"); } })).toBe(false);
    expect(Core.consentAllowsAnalytics({ userCanBeTracked: () => 0 })).toBe(false);
  });
  it("prefers analyticsProcessingAllowed over userCanBeTracked", () => {
    expect(Core.consentAllowsAnalytics({ analyticsProcessingAllowed: () => false, userCanBeTracked: () => true })).toBe(false);
  });
});

describe("Phase 8.1 — no unguarded A/B token access (static, H1)", () => {
  const files = ["assets/boost-results.js", "assets/boost-predictive.js"];
  for (const f of files) {
    it(`${f} references the consent gate and guards every boost_abt read/create`, () => {
      const src = readFileSync(join(EXT, f), "utf8");
      expect(src.includes("consentAllowsAnalytics")).toBe(true);
      const lines = src.split("\n");
      // Every create/read of the token must have a consent reference within the
      // preceding 6 lines (the guarding helper checks consent first).
      lines.forEach((line, i) => {
        const touchesToken = /\.(getItem|setItem)\(\s*["']boost_abt["']/.test(line);
        if (!touchesToken) return;
        const window = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
        expect(/consentOk\(|consentAllowsAnalytics/.test(window), `${f}:${i + 1} unguarded token access`).toBe(true);
      });
      // The old unconditional creator must be gone.
      expect(src.includes("function getVisitorToken()")).toBe(false);
    });
  }
});
