import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkParity } from "../scripts/check-locale-parity.mjs";

/*
 * Phase 10 — pure core helpers + static checks on the Bundle block/glue.
 * DOM-dependent behaviour (fetch, render, cart POST) is Requires Verification.
 */
const require = createRequire(import.meta.url);
const EXT = join(__dirname, "..", "extensions", "search-discovery-theme");
const required = require(join(EXT, "assets", "boost-core.js"));
const Core = required && required.cartAddUrl ? required : (globalThis as any).BoostSearch;

describe("Phase 10 boost-core — cart helpers (pure)", () => {
  it("cartAddUrl builds a root-relative add endpoint and defaults safely", () => {
    expect(Core.cartAddUrl("/")).toBe("/cart/add.js");
    expect(Core.cartAddUrl("/en-gb/")).toBe("/en-gb/cart/add.js");
    expect(Core.cartAddUrl("/fr")).toBe("/fr/cart/add.js");      // trailing slash added
    expect(Core.cartAddUrl(undefined)).toBe("/cart/add.js");
    expect(Core.cartAddUrl("//evil.com/")).toBe("/cart/add.js"); // protocol-relative → reset
    expect(Core.cartAddUrl("https://evil.com/")).toBe("/cart/add.js"); // not root-relative → reset
  });
  it("isNumericId accepts bare positive integer ids only", () => {
    expect(Core.isNumericId("123")).toBe(true);
    expect(Core.isNumericId(123)).toBe(true);
    expect(Core.isNumericId("gid://shopify/ProductVariant/1")).toBe(false);
    expect(Core.isNumericId("12a")).toBe(false);
    expect(Core.isNumericId("-5")).toBe(false);
    expect(Core.isNumericId("")).toBe(false);
    expect(Core.isNumericId(0)).toBe(false);
  });
});

describe("Phase 10 — Bundle block + glue (static)", () => {
  const block = readFileSync(join(EXT, "blocks", "boost-bundle.liquid"), "utf8");
  const glue = readFileSync(join(EXT, "assets", "boost-bundle.js"), "utf8");

  it("files exist and are wired", () => {
    expect(existsSync(join(EXT, "assets", "boost-bundle.js"))).toBe(true);
    expect(block.includes("boost-bundle.js")).toBe(true);
    expect(block.includes("boost-core.js")).toBe(true);
    expect(/default:\s*'apps'/.test(block)).toBe(true);
    expect(/default:\s*'search'/.test(block)).toBe(true);
  });

  it("schema JSON is valid and the target is a product section", () => {
    const m = block.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
    expect(m).toBeTruthy();
    const schema = JSON.parse(m![1]);
    expect(schema.target).toBe("section");
    expect(schema.name).toBe("Bundle");
  });

  it("default-false checkbox show_vendor uses the '== true' form (schema-default aware)", () => {
    expect(/\{%\s*if\s+block\.settings\.show_vendor\s*==\s*true\s*%\}/.test(block)).toBe(true);
    expect(/block\.settings\.show_vendor\s*\|\s*default:/.test(block)).toBe(false);
  });

  it("glue routes links/images/prices through the fail-closed Core helpers", () => {
    expect(glue.includes("Core.toSameSitePath(")).toBe(true);
    expect(glue.includes("Core.isSafeImageUrl(")).toBe(true);
    expect(glue.includes("Core.formatPrice(")).toBe(true);
    expect(glue.includes("Core.cartAddUrl(")).toBe(true);
  });

  it("cart add uses only validated numeric variant ids + bundle line properties", () => {
    expect(glue.includes("Core.isNumericId(")).toBe(true);
    expect(glue.includes("id: Number(opt.variantId)")).toBe(true);
    expect(glue.includes("_bundle_id")).toBe(true);
    expect(glue.includes("_bundle_slot")).toBe(true);
  });

  it("renders with textContent/DOM only — never innerHTML", () => {
    expect(glue.includes("innerHTML")).toBe(false);
    expect(glue.includes("textContent")).toBe(true);
    expect(glue.includes("createElement")).toBe(true);
  });

  it("does not assume cart atomicity (partial-failure handled honestly)", () => {
    // on a non-OK response it shows an error rather than claiming success
    expect(/res && res\.ok/.test(glue)).toBe(true);
    expect(glue.includes("addError")).toBe(true);
  });

  it("locale parity holds across all extension locales (incl. bundle keys)", () => {
    const { ok, problems } = checkParity(join(EXT, "locales"));
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });
});
