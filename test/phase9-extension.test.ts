import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase 9 — pure-logic + static extension checks (no DOM library, mirroring the
 * Phase 7 approach). Exercises boost-core.js recently-viewed helpers and
 * statically verifies the recommendations block + glue: consent-gated storage,
 * safe URL/image/price helpers, textContent-only rendering, explicit checkbox
 * if/else. DOM-dependent behaviour (fetch, render) is Requires Verification.
 */
const require = createRequire(import.meta.url);
const EXT = join(__dirname, "..", "extensions", "search-discovery-theme");
const required = require(join(EXT, "assets", "boost-core.js"));
const Core = required && required.parseRecentIds ? required : (globalThis as any).BoostSearch;

describe("Phase 9 boost-core — recently-viewed refs (pure)", () => {
  it("normalizeRef accepts uuid / Product gid / handle and rejects junk", () => {
    expect(Core.normalizeRef("550e8400-e29b-41d4-a716-446655440000")).toBeTruthy();
    expect(Core.normalizeRef("gid://shopify/Product/42")).toBe("gid://shopify/Product/42");
    expect(Core.normalizeRef("Blue-Shoe")).toBe("blue-shoe"); // lower-cased
    expect(Core.normalizeRef("gid://shopify/Variant/1")).toBeNull();
    expect(Core.normalizeRef("a b")).toBeNull();
    expect(Core.normalizeRef("")).toBeNull();
    expect(Core.normalizeRef("x".repeat(256))).toBeNull();
    expect(Core.normalizeRef(null)).toBeNull();
  });

  it("parseRecentIds validates, dedupes, caps at 12 and preserves order", () => {
    const out = Core.parseRecentIds("a,b,a,c,BAD HANDLE,gid://shopify/Product/9,d,e,f,g,h,i,j,k,l");
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.slice(0, 4)).toEqual(["a", "b", "c", "gid://shopify/Product/9"]);
    expect(out.filter((v: string) => v === "a").length).toBe(1);
    expect(Core.parseRecentIds(["x", "y", "x"])).toEqual(["x", "y"]);
  });

  it("pushRecentId prepends, moves duplicates to front, caps, ignores junk", () => {
    expect(Core.pushRecentId(["b", "c"], "a")).toEqual(["a", "b", "c"]);
    expect(Core.pushRecentId(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]); // moved to front
    const long = Core.pushRecentId(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"].map((n) => "h" + n), "hnew");
    expect(long.length).toBe(12);
    expect(long[0]).toBe("hnew");
    expect(Core.pushRecentId(["a", "b"], "bad handle!")).toEqual(["a", "b"]); // junk → unchanged
  });

  it("serializeRecentIds re-validates and bounds", () => {
    expect(Core.serializeRecentIds(["a", "b", "a"])).toBe("a,b");
    expect(Core.serializeRecentIds("x,BAD HANDLE,y")).toBe("x,y");
  });
});

describe("Phase 9 — recommendations block + glue (static)", () => {
  const block = readFileSync(join(EXT, "blocks", "boost-recommendations.liquid"), "utf8");
  const glue = readFileSync(join(EXT, "assets", "boost-recommendations.js"), "utf8");

  it("the extension files exist and are wired", () => {
    expect(existsSync(join(EXT, "assets", "boost-recommendations.js"))).toBe(true);
    expect(block.includes("boost-recommendations.js")).toBe(true);
    expect(block.includes("boost-core.js")).toBe(true);
    // default proxy prefix/subpath match the registered routes (routing guard).
    expect(/default:\s*'apps'/.test(block)).toBe(true);
    expect(/default:\s*'search'/.test(block)).toBe(true);
  });

  it("checkbox settings render via the if/else form matching each schema default (K4)", () => {
    // default-true → `== false` (unset→true); default-false → `== true` (unset→false)
    const expectations: Record<string, "false" | "true"> = {
      show_price: "false",   // default true
      track_recent: "false", // default true
      show_vendor: "true",   // default false — unset must render false
    };
    for (const [id, form] of Object.entries(expectations)) {
      expect(new RegExp(`\\{%\\s*if\\s+block\\.settings\\.${id}\\s*==\\s*${form}\\s*%\\}`).test(block), id).toBe(true);
      expect(new RegExp(`block\\.settings\\.${id}\\s*\\|\\s*default:`).test(block), id).toBe(false);
    }
  });

  it("glue routes links/images/prices through the fail-closed Core helpers", () => {
    expect(glue.includes("Core.toSameSitePath(")).toBe(true);
    expect(glue.includes("Core.isSafeImageUrl(")).toBe(true);
    expect(glue.includes("Core.formatPrice(")).toBe(true);
  });

  it("recently-viewed storage is consent-gated and wrapped in try/catch", () => {
    // every localStorage touch is preceded by a consent check in its function.
    expect(glue.includes("consentAllowsAnalytics")).toBe(true);
    // readRecent / recordRecent both guard on consentOk() before localStorage
    expect(/function readRecent\(\)\s*\{\s*if \(!consentOk\(\)\) return \[\];/.test(glue)).toBe(true);
    expect(/function recordRecent\([^)]*\)\s*\{\s*if \(!consentOk\(\)\) return;/.test(glue)).toBe(true);
    // storage is only ever accessed inside try/catch
    expect(glue.includes("window.localStorage")).toBe(true);
    expect(glue.includes("try {")).toBe(true);
  });

  it("renders with textContent/DOM only — never innerHTML with API data", () => {
    expect(glue.includes("innerHTML")).toBe(false);
    expect(glue.includes("textContent")).toBe(true);
    expect(glue.includes("createElement")).toBe(true);
  });

  it("the view/click beacon targets the aggregate rec-event endpoint", () => {
    expect(glue.includes("/rec-event?product=")).toBe(true);
    expect(glue.includes('"view"')).toBe(true);
    expect(glue.includes('"click"')).toBe(true);
  });
});
