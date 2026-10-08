import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkParity, flattenKeys } from "../scripts/check-locale-parity.mjs";

/*
 * Phase 7 — pure-logic tests (no DOM library; none added per the brief).
 * Exercises boost-core.js (URL state, proxy URL, URL validation, fallback
 * decision, ARIA combobox keyboard logic), locale key parity, and static
 * validity of the theme app extension (schema JSON + required files).
 * DOM-dependent behavior (actual rendering, focus, fetch) is Requires
 * Verification — documented in docs/PHASE7_REPORT.md.
 */

const require = createRequire(import.meta.url);
const EXT = join(__dirname, "..", "extensions", "search-discovery-theme");
const required = require(join(EXT, "assets", "boost-core.js"));
// UMD sets module.exports and/or globalThis.BoostSearch depending on the loader.
const Core = required && required.parseState ? required : (globalThis as any).BoostSearch;

describe("Phase 7 boost-core — parseState (never trusts URL params)", () => {
  it("defaults an empty/absent state", () => {
    const s = Core.parseState({});
    expect(s).toMatchObject({ q: "", sort: "relevance", page: 1, nl: true });
    expect(s.vendor).toEqual([]);
    expect(s.priceMin).toBeNull();
    expect(s.ignore).toEqual([]);
  });

  it("rejects hostile / out-of-range params", () => {
    const s = Core.parseState({
      sort: "'; DROP TABLE product; --",
      page: "-5",
      priceMin: "-3",
      priceMax: "2000000000", // > 1e9
      nl: "0",
      ignore: "price,bogus,vendor,price",
    });
    expect(s.sort).toBe("relevance"); // unknown sort → relevance
    expect(s.page).toBe(1);
    expect(s.priceMin).toBeNull();
    expect(s.priceMax).toBeNull();
    expect(s.nl).toBe(false);
    expect(s.ignore).toEqual(["price", "vendor"]); // filtered + de-duped
  });

  it("caps page, count, and value length; strips control chars", () => {
    const many = Array.from({ length: 80 }, (_, i) => "v" + i);
    const s = Core.parseState({ page: "999999999", vendor: many, q: "re\u0000d\u0001 shoe" });
    expect(s.page).toBe(100000);
    expect(s.vendor.length).toBe(Core.MAX_FILTER_VALUES); // 50
    expect(s.q.indexOf("\u0000")).toBe(-1);
    const longName = "x".repeat(300);
    const s2 = Core.parseState({ tags: longName });
    expect(s2.tags[0].length).toBe(Core.MAX_FILTER_STR); // 100
  });

  it("accepts comma strings and repeated params for multi-values", () => {
    expect(Core.parseState({ tags: "a,b,c" }).tags).toEqual(["a", "b", "c"]);
    expect(Core.parseState({ tags: ["a", "b"] }).tags).toEqual(["a", "b"]);
  });
});

describe("Phase 7 boost-core — serializeState", () => {
  it("round-trips through parseState", () => {
    const state = {
      q: "red shoe", vendor: ["Nike", "Adidas"], productType: [], tags: ["Red"],
      metafield: [], priceMin: 10, priceMax: 50, available: true, collectionId: null,
      sort: "price_asc", page: 3, nl: false, ignore: ["price"],
    };
    const qs = Core.serializeState(state);
    const back = Core.parseState(new URLSearchParams(qs));
    expect(back.q).toBe("red shoe");
    expect(back.vendor.slice().sort()).toEqual(["Adidas", "Nike"]);
    expect(back.tags).toEqual(["Red"]);
    expect(back.priceMin).toBe(10);
    expect(back.priceMax).toBe(50);
    expect(back.available).toBe(true);
    expect(back.sort).toBe("price_asc");
    expect(back.page).toBe(3);
    expect(back.nl).toBe(false);
    expect(back.ignore).toEqual(["price"]);
  });

  it("is deterministic and omits defaults", () => {
    const a = Core.serializeState({ q: "x", vendor: ["B", "A"], sort: "relevance", page: 1, nl: true });
    const b = Core.serializeState({ vendor: ["A", "B"], q: "x" });
    expect(a).toBe(b); // stable order, sorted multi-values, defaults omitted
    expect(a.indexOf("sort=")).toBe(-1);
    expect(a.indexOf("page=")).toBe(-1);
    expect(a.indexOf("nl=")).toBe(-1);
  });
});

describe("Phase 7 boost-core — buildProxyUrl", () => {
  it("products: adds limit/offset from page, drops raw page param", () => {
    const url = Core.buildProxyUrl("/apps/search", "products", { q: "red", page: 3 }, 24);
    expect(url.startsWith("/apps/search/products?")).toBe(true);
    expect(url).toContain("limit=24");
    expect(url).toContain("offset=48");
    expect(url).toContain("q=red");
    expect(url).not.toContain("page=");
  });
  it("predictive: just the query; trims trailing slash on base", () => {
    const url = Core.buildProxyUrl("/apps/search/", "predictive", { q: "sh oe" });
    expect(url.startsWith("/apps/search/predictive?")).toBe(true);
    expect(url).toContain("q=sh%20oe");
    expect(url).not.toContain("limit=");
  });
});

describe("Phase 7 boost-core — isSafeUrl (same-site only)", () => {
  it("accepts root-relative paths", () => {
    expect(Core.isSafeUrl("/products/x")).toBe(true);
    expect(Core.isSafeUrl("/a?b=1&c=2")).toBe(true);
  });
  it("rejects absolute, protocol-relative, scheme, and junk", () => {
    for (const u of ["//evil.com", "https://evil.com", "http://x", "javascript:alert(1)",
      "/javascript:alert(1)", "/\\evil.com", "", "  ", "mailto:x@y.z", "/\u0000x"]) {
      expect(Core.isSafeUrl(u), u).toBe(false);
    }
  });
});

describe("Phase 7.1 boost-core — toSameSitePath (allowlist, fail-closed)", () => {
  const allow = ["shop.myshopify.com", "www.mystore.com"];
  const cur = "www.mystore.com";

  it("accepts real-shaped URLs and returns a same-site relative path", () => {
    expect(Core.toSameSitePath("/products/red-shoe", allow, cur)).toBe("/products/red-shoe");
    // absolute myshopify onlineStoreUrl
    expect(Core.toSameSitePath("https://shop.myshopify.com/products/red-shoe?v=1", allow, cur)).toBe("/products/red-shoe?v=1");
    // absolute custom-domain onlineStoreUrl
    expect(Core.toSameSitePath("https://www.mystore.com/products/x", allow, cur)).toBe("/products/x");
    // absolute same-domain redirect destination (Phase 5) converts to relative
    expect(Core.toSameSitePath("https://www.mystore.com/pages/sale", allow, cur)).toBe("/pages/sale");
    // uppercase scheme + host accepted (host matched case-insensitively)
    expect(Core.toSameSitePath("HTTPS://SHOP.MYSHOPIFY.COM/Products/X", allow, cur)).toBe("/Products/X");
    // trailing-dot host + port both tolerated (port ignored in host match)
    expect(Core.toSameSitePath("https://shop.myshopify.com./products/x", allow, cur)).toBe("/products/x");
    expect(Core.toSameSitePath("https://shop.myshopify.com:443/products/x", allow, cur)).toBe("/products/x");
    // currentHost match even when not in the allowlist
    expect(Core.toSameSitePath("https://www.mystore.com/x", [], cur)).toBe("/x");
  });

  it("rejects every hostile URL (returns null)", () => {
    const a = ["good.com", "shop.myshopify.com"];
    for (const u of [
      "https://evil.com/x",
      "https://good.com@evil.com",       // userinfo trick
      "https://good.com.evil.com/x",     // added-label look-alike
      "https://evilgood.com/x",          // prefix look-alike
      "//evil.com",                       // protocol-relative
      "javascript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc/passwd",
      "/\\evil.com",                      // backslash
      "/%0a/x",                           // encoded control in relative
      "https://exa%0a.com/x",            // encoded control in host
      "http://",                           // malformed
      "",
      "   ",
      null as any,
    ]) {
      expect(Core.toSameSitePath(u, a, cur), String(u)).toBeNull();
    }
  });
});

describe("Phase 7.1 boost-core — isSafeImageUrl (https + host allowlist)", () => {
  const imgHosts = ["cdn.shopify.com", "www.mystore.com"];
  it("accepts a CDN https image (with ?v=) and root-relative, case-insensitively", () => {
    expect(Core.isSafeImageUrl("https://cdn.shopify.com/s/files/1/0001/0002/products/red.jpg?v=1700000000", imgHosts)).toBe(true);
    expect(Core.isSafeImageUrl("/cdn/shop/products/x.jpg", imgHosts)).toBe(true);
    expect(Core.isSafeImageUrl("HTTPS://CDN.SHOPIFY.COM/x.jpg", imgHosts)).toBe(true);
  });
  it("rejects http, foreign hosts, protocol-relative, schemes, empty", () => {
    for (const u of ["http://cdn.shopify.com/x.jpg", "https://evil.com/x.jpg",
      "//cdn.shopify.com/x.jpg", "javascript:x", "", null as any]) {
      expect(Core.isSafeImageUrl(u, imgHosts), String(u)).toBe(false);
    }
  });
});

describe("Phase 7.1 boost-core — formatPrice", () => {
  it("formats single, range, and equal min/max with currency", () => {
    expect(Core.formatPrice("50", "80", "USD", "en-US")).toBe("$50.00–$80.00");
    expect(Core.formatPrice("50", null, "USD", "en-US")).toBe("$50.00");
    expect(Core.formatPrice("50", "50", "USD", "en-US")).toBe("$50.00"); // equal → single
  });
  it("falls back to plain numbers on missing/invalid currency, and empty on no price", () => {
    expect(Core.formatPrice("50", "80", null, undefined)).toBe("50–80");
    expect(Core.formatPrice("50", null, "US", "en-US")).toBe("50"); // invalid code → plain
    expect(Core.formatPrice(null, null, "USD", "en-US")).toBe("");
    expect(Core.formatPrice("", "", "USD", "en-US")).toBe("");
  });
});

describe("Phase 7 boost-core — decideFallback", () => {
  it("falls back on timeout, http error, missing body, or native flag", () => {
    expect(Core.decideFallback({ timedOut: true })).toBe(true);
    expect(Core.decideFallback({ httpError: true })).toBe(true);
    expect(Core.decideFallback({ body: null })).toBe(true);
    expect(Core.decideFallback({ body: { fallback: "native" } })).toBe(true);
  });
  it("does not fall back on a normal body", () => {
    expect(Core.decideFallback({ body: { products: [], total: 0 } })).toBe(false);
  });
});

describe("Phase 7 boost-core — comboboxKey (ARIA keyboard logic)", () => {
  it("ArrowDown/Up wrap within the listbox when open", () => {
    expect(Core.comboboxKey({ open: true, index: -1 }, "ArrowDown", 3)).toMatchObject({ index: 0, action: "move" });
    expect(Core.comboboxKey({ open: true, index: 2 }, "ArrowDown", 3)).toMatchObject({ index: 0 });
    expect(Core.comboboxKey({ open: true, index: 0 }, "ArrowUp", 3)).toMatchObject({ index: 2 });
  });
  it("does nothing on arrows when closed", () => {
    expect(Core.comboboxKey({ open: false, index: -1 }, "ArrowDown", 3).action).toBe("none");
  });
  it("Home/End jump to ends", () => {
    expect(Core.comboboxKey({ open: true, index: 2 }, "Home", 3)).toMatchObject({ index: 0, action: "move" });
    expect(Core.comboboxKey({ open: true, index: 0 }, "End", 3)).toMatchObject({ index: 2, action: "move" });
  });
  it("Escape closes; Enter selects the active option or submits when none", () => {
    expect(Core.comboboxKey({ open: true, index: 1 }, "Escape", 3)).toMatchObject({ open: false, action: "close" });
    expect(Core.comboboxKey({ open: true, index: 1 }, "Enter", 3)).toMatchObject({ action: "select", index: 1 });
    expect(Core.comboboxKey({ open: true, index: -1 }, "Enter", 3)).toMatchObject({ action: "submit" });
  });
});

describe("Phase 7 — locale key parity", () => {
  it("every locale file matches its en.default base", () => {
    const res = checkParity(join(EXT, "locales"));
    if (!res.ok) console.error(JSON.stringify(res.problems, null, 2));
    expect(res.ok).toBe(true);
  });
  it("flattenKeys produces a stable sorted list", () => {
    const keys = flattenKeys({ a: { b: 1, a: 2 }, c: 3 });
    expect(keys).toEqual(["a.a", "a.b", "c"]);
  });
});

describe("Phase 7 — theme app extension static validity", () => {
  const blocks = [
    { file: "boost-predictive.liquid", target: "body" },
    { file: "boost-results.liquid", target: "section" },
  ];

  function extractSchema(src: string): any {
    const m = src.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
    if (!m) throw new Error("no schema block");
    return JSON.parse(m[1]);
  }

  for (const b of blocks) {
    it(`${b.file}: schema is valid JSON with the right target and a short name`, () => {
      const src = readFileSync(join(EXT, "blocks", b.file), "utf8");
      const schema = extractSchema(src);
      expect(schema.target).toBe(b.target);
      expect(typeof schema.name).toBe("string");
      expect(schema.name.length).toBeLessThan(25); // theme-editor sidebar limit
      expect(Array.isArray(schema.settings)).toBe(true);
    });
  }

  it("required files are present", () => {
    const required = [
      "shopify.extension.toml",
      "blocks/boost-predictive.liquid",
      "blocks/boost-results.liquid",
      "assets/boost-core.js",
      "assets/boost-predictive.js",
      "assets/boost-results.js",
      "assets/boost.css",
      "locales/en.default.json",
      "locales/en.default.schema.json",
    ];
    for (const f of required) expect(existsSync(join(EXT, f)), f).toBe(true);
  });

  it("shopify.extension.toml declares a theme extension", () => {
    const toml = readFileSync(join(EXT, "shopify.extension.toml"), "utf8");
    expect(/type\s*=\s*"theme"/.test(toml)).toBe(true);
  });

  it("every settings label referenced in a block exists in the schema locale", () => {
    const schemaLocale = JSON.parse(readFileSync(join(EXT, "locales", "en.default.schema.json"), "utf8"));
    const keys = new Set(flattenKeys(schemaLocale));
    for (const b of blocks) {
      const src = readFileSync(join(EXT, "blocks", b.file), "utf8");
      const refs = src.match(/t:([a-zA-Z0-9_.]+)/g) || [];
      for (const r of refs) {
        const key = r.slice(2); // drop "t:"
        expect(keys.has(key), `${b.file} → ${key}`).toBe(true);
      }
    }
  });

  it("storefront t-filters used by the results block exist in en.default.json", () => {
    const strings = JSON.parse(readFileSync(join(EXT, "locales", "en.default.json"), "utf8"));
    const keys = new Set(flattenKeys(strings));
    const src = readFileSync(join(EXT, "blocks", "boost-results.liquid"), "utf8");
    const refs = src.match(/'(boost\.[a-zA-Z0-9_.]+)'\s*\|\s*t/g) || [];
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      const key = r.match(/'(boost\.[a-zA-Z0-9_.]+)'/)![1];
      expect(keys.has(key), key).toBe(true);
    }
  });
});
