import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkParity } from "../scripts/check-locale-parity.mjs";

/*
 * Phase 13.2 — client i18n helpers (boost-core) + locale key parity across ALL
 * shipped locales. DOM wiring is Requires Verification; the pure helpers here
 * mirror the server resolver (app/lib/i18n/locales.ts).
 */
const require = createRequire(import.meta.url);
const EXT = join(__dirname, "..", "extensions", "search-discovery-theme");
const required = require(join(EXT, "assets", "boost-core.js"));
const Core = required && required.resolveLocale ? required : (globalThis as any).BoostSearch;
const LOCALES = join(EXT, "locales");

describe("Phase 13.2 — key parity across all 9 locales", () => {
  it("every storefront + schema locale matches en.default exactly", () => {
    const { ok, problems } = checkParity(LOCALES);
    expect(problems, JSON.stringify(problems)).toEqual([]);
    expect(ok).toBe(true);
  });
  it("ships exactly the 9 expected runtime locales", () => {
    const files = readdirSync(LOCALES).filter((f) => f.endsWith(".json") && !f.endsWith(".schema.json"));
    expect(files.sort()).toEqual(
      ["ar.json", "de.json", "en.default.json", "es.json", "fr.json", "it.json", "ja.json", "nl.json", "pt-BR.json"].sort(),
    );
  });
});

describe("Phase 13.2 — client resolveLocale mirrors the server", () => {
  it("exact → base → default", () => {
    expect(Core.resolveLocale("pt-BR")).toBe("pt-BR");
    expect(Core.resolveLocale("pt")).toBe("pt-BR");
    expect(Core.resolveLocale("de-AT")).toBe("de");
    expect(Core.resolveLocale("klingon")).toBe("en");
    expect(Core.resolveLocale(null)).toBe("en");
  });
  it("localeDir: ar rtl", () => {
    expect(Core.localeDir("ar")).toBe("rtl");
    expect(Core.localeDir("en")).toBe("ltr");
  });
  it("applyLocaleToRoot sets lang+dir on the given element only", () => {
    const attrs: Record<string, string> = {};
    const fakeEl = { setAttribute: (k: string, v: string) => { attrs[k] = v; } };
    Core.applyLocaleToRoot(fakeEl, "ar");
    expect(attrs.lang).toBe("ar");
    expect(attrs.dir).toBe("rtl");
  });
});

describe("Phase 13.2 — Intl plural + date (no concatenation)", () => {
  it("formatCount picks the right plural template and formats the number", () => {
    const forms = { one: "{count} result", other: "{count} results" };
    expect(Core.formatCount(1, "en", forms)).toBe("1 result");
    expect(Core.formatCount(5, "en", forms)).toBe("5 results");
    expect(Core.formatCount(0, "en", forms)).toBe("0 results");
    // grouping via Intl.NumberFormat (no manual string building)
    expect(Core.formatCount(1234, "en", forms)).toBe("1,234 results");
  });
  it("pluralCategory uses Intl.PluralRules", () => {
    expect(Core.pluralCategory("en", 1)).toBe("one");
    expect(Core.pluralCategory("en", 2)).toBe("other");
    expect(Core.pluralCategory("ja", 1)).toBe("other"); // Japanese has no singular
  });
  it("formatDateInTz formats in an explicit IANA zone, empty on junk", () => {
    const s = Core.formatDateInTz("2026-06-15T00:00:00Z", "en-US", "America/New_York");
    expect(s).toMatch(/Jun/);
    expect(Core.formatDateInTz("not-a-date", "en", "UTC")).toBe("");
  });
});

describe("Phase 13.2 — STATIC: app sets dir on its OWN root, never <html>", () => {
  it("no asset writes dir/lang to documentElement or <html>", () => {
    for (const a of ["boost-results.js", "boost-predictive.js", "boost-core.js"]) {
      const src = readFileSync(join(EXT, "assets", a), "utf8");
      expect(/documentElement\.(setAttribute|dir|lang)/.test(src), `${a} must not touch <html>`).toBe(false);
    }
  });
});
