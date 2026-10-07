import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
} from "~/lib/index/engine";
import { storefrontSearchWithExec } from "~/lib/search/storefront";

/**
 * Phase 6.1 fix-batch regression tests (A2 case-insensitive live attribute
 * values, A3 negation transparency, A4 control-character safety, and NL ==
 * manual-equivalent). These run the REAL engine through node-postgres (same SQL
 * as production Prisma via the Exec abstraction).
 */

interface Seed {
  gid: string; title: string; vendor: string; type: string; tags: string[];
  price: string; available: boolean; status?: string; published?: boolean; created?: string;
  material?: string;
}
async function seed(db: TestDb, shop: string, s: Seed) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: s.gid, title: s.title, handle: s.gid, vendor: s.vendor, productType: s.type,
      tags: s.tags, status: s.status ?? "ACTIVE",
      // published = (online_store_url IS NOT NULL); a null URL = unpublished.
      onlineStoreUrl: (s.published ?? true) ? `https://x/${s.gid}` : null,
      metafields: s.material ? { "custom.material": s.material } : {},
      productCreatedAt: s.created ?? "2024-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: s.gid + "/v", sku: "SKU-" + s.gid, price: s.price, availableForSale: s.available });
  });
}
async function build(db: TestDb, shop: string) {
  const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  return v.id;
}

describe("Phase 6.1 — fix batch", () => {
  let db: TestDb;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(() => db.resetDb());

  // --- A2: case-insensitive attribute values against LIVE visible facets ---
  describe("A2 — case-insensitive live attribute values", () => {
    it('a product tagged "Red" is found by "red" and applies the live-cased value', async () => {
      const shop = await db.resolveShop("a2a.myshopify.com");
      await seed(db, shop, { gid: "1", title: "Crimson Tee", vendor: "V", type: "Tee", tags: ["Red"], price: "20.00", available: true });
      await seed(db, shop, { gid: "2", title: "Blue Tee", vendor: "V", type: "Tee", tags: ["Blue"], price: "20.00", available: true });
      await build(db, shop);

      const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "red" }));
      expect(r.interpretedAs.applied).toBe(true);
      // The LIVE casing ("Red") is applied, not the lower-cased dictionary value.
      expect(r.appliedFilters.tags).toContain("Red");
      expect(r.appliedFilters.tags).not.toContain("red");
      expect(r.products.map((p) => p.title)).toEqual(["Crimson Tee"]);
    });

    it("a draft-only tag value is never applied (stays free text, no draft leakage)", async () => {
      const shop = await db.resolveShop("a2b.myshopify.com");
      // "red" exists ONLY on a DRAFT product → not a live visible value.
      await seed(db, shop, { gid: "1", title: "Secret Red", vendor: "V", type: "Tee", tags: ["red"], price: "20.00", available: true, status: "DRAFT" });
      await seed(db, shop, { gid: "2", title: "Blue Tee", vendor: "V", type: "Tee", tags: ["blue"], price: "20.00", available: true });
      await build(db, shop);

      const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "red" }));
      // "red" did NOT resolve to a live value → not applied as a tag filter.
      expect(r.appliedFilters.tags ?? []).not.toContain("red");
      expect(r.interpretedAs.interpreted.some((i) => i.kind === "attribute")).toBe(false);
      // The draft product never surfaces.
      expect(r.products.map((p) => p.title)).not.toContain("Secret Red");
    });

    it("cross-shop isolation of the live values", async () => {
      const shopA = await db.resolveShop("a2c-a.myshopify.com");
      await seed(db, shopA, { gid: "1", title: "A Red", vendor: "V", type: "Tee", tags: ["Red"], price: "20.00", available: true });
      await build(db, shopA);

      const shopB = await db.resolveShop("a2c-b.myshopify.com");
      // Shop B has NO red tag at all — only "Teal".
      await seed(db, shopB, { gid: "1", title: "B Teal", vendor: "V", type: "Tee", tags: ["Teal"], price: "20.00", available: true });
      await build(db, shopB);

      // Shop A resolves "red" → "Red" (its own live value).
      const a = await db.withShopExec(shopA, (e) => storefrontSearchWithExec(e, shopA, { q: "red" }));
      expect(a.appliedFilters.tags).toContain("Red");
      // Shop B has no live "red": the term stays free text, no tag filter applied,
      // and shop A's "Red" casing never leaks across tenants.
      const b = await db.withShopExec(shopB, (e) => storefrontSearchWithExec(e, shopB, { q: "red" }));
      expect(b.appliedFilters.tags ?? []).not.toContain("Red");
      expect(b.appliedFilters.tags ?? []).not.toContain("red");
    });
  });

  // --- B1: ALL live casings applied (mixed-case duplicates) ---
  describe("B1 — mixed-case duplicates apply ALL live casings", () => {
    it('tags "red"/"Red"/"RED" on three products → "red" finds all three; NL == manual', async () => {
      const shop = await db.resolveShop("b1a.myshopify.com");
      await seed(db, shop, { gid: "1", title: "P lower", vendor: "V", type: "Tee", tags: ["red"], price: "10.00", available: true });
      await seed(db, shop, { gid: "2", title: "P title", vendor: "V", type: "Tee", tags: ["Red"], price: "20.00", available: true });
      await seed(db, shop, { gid: "3", title: "P upper", vendor: "V", type: "Tee", tags: ["RED"], price: "30.00", available: true });
      await build(db, shop);

      const nl = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "red" }));
      expect(nl.total).toBe(3);
      expect(nl.products.map((p) => p.id).sort()).toHaveLength(3);
      // All three casings are applied as the tag filter.
      expect([...(nl.appliedFilters.tags ?? [])].sort()).toEqual(["RED", "Red", "red"]);

      // NL == manual-equivalent (products, total, facets) with the same casings.
      const manual = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, {
        q: "", nl: false, filters: { tags: ["red", "Red", "RED"] },
      }));
      expect(nl.products.map((p) => p.id)).toEqual(manual.products.map((p) => p.id));
      expect(nl.total).toBe(manual.total);
      const norm = (fs: any[]) => fs.map((f) => ({ key: f.key, opts: f.options.map((o: any) => [o.value, o.count]).sort() })).sort((a, b) => a.key.localeCompare(b.key));
      expect(norm(nl.facets)).toEqual(norm(manual.facets));
    });

    it("a configured metafield value in two casings → both applied", async () => {
      const shop = await db.resolveShop("b1b.myshopify.com");
      await seed(db, shop, { gid: "1", title: "Leather A", vendor: "V", type: "Bag", tags: [], price: "10.00", available: true, material: "Leather" });
      await seed(db, shop, { gid: "2", title: "Leather B", vendor: "V", type: "Bag", tags: [], price: "20.00", available: true, material: "LEATHER" });
      await build(db, shop);

      const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "leather" }));
      expect(r.total).toBe(2);
      expect([...(r.appliedFilters.metafield ?? [])].sort()).toEqual(["LEATHER", "Leather"]);
    });

    it('vendor "Nike" and "NIKE" → "nike" finds both', async () => {
      const shop = await db.resolveShop("b1c.myshopify.com");
      await seed(db, shop, { gid: "1", title: "Nike A", vendor: "Nike", type: "Shoe", tags: [], price: "10.00", available: true });
      await seed(db, shop, { gid: "2", title: "Nike B", vendor: "NIKE", type: "Shoe", tags: [], price: "20.00", available: true });
      await build(db, shop);

      const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "nike" }));
      expect(r.total).toBe(2);
      expect([...(r.appliedFilters.vendor ?? [])].sort()).toEqual(["NIKE", "Nike"]);
    });

    it("a draft-only casing is never applied", async () => {
      const shop = await db.resolveShop("b1d.myshopify.com");
      // "red" (lower) is published; "RED" exists ONLY on a draft product.
      await seed(db, shop, { gid: "1", title: "Live red", vendor: "V", type: "Tee", tags: ["red"], price: "10.00", available: true });
      await seed(db, shop, { gid: "2", title: "Draft RED", vendor: "V", type: "Tee", tags: ["RED"], price: "20.00", available: true, status: "DRAFT" });
      await build(db, shop);

      const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "red" }));
      expect([...(r.appliedFilters.tags ?? [])]).toEqual(["red"]); // only the live casing
      expect(r.products.map((p) => p.title)).not.toContain("Draft RED");
    });

    it("cross-shop casings do not leak", async () => {
      const shopA = await db.resolveShop("b1e-a.myshopify.com");
      await seed(db, shopA, { gid: "1", title: "A", vendor: "V", type: "Tee", tags: ["RED"], price: "10.00", available: true });
      await build(db, shopA);
      const shopB = await db.resolveShop("b1e-b.myshopify.com");
      await seed(db, shopB, { gid: "1", title: "B", vendor: "V", type: "Tee", tags: ["red"], price: "10.00", available: true });
      await build(db, shopB);

      const a = await db.withShopExec(shopA, (e) => storefrontSearchWithExec(e, shopA, { q: "red" }));
      expect([...(a.appliedFilters.tags ?? [])]).toEqual(["RED"]); // A's only casing
      const b = await db.withShopExec(shopB, (e) => storefrontSearchWithExec(e, shopB, { q: "red" }));
      expect([...(b.appliedFilters.tags ?? [])]).toEqual(["red"]); // B's only casing — A's "RED" never leaks
    });
  });

  // --- A3: negation transparency (machine-readable flag + warning) ---
  describe("A3 — negation transparency", () => {
    it('negationIgnored present for "shoe not red"', async () => {
      const shop = await db.resolveShop("a3.myshopify.com");
      await seed(db, shop, { gid: "1", title: "Red Shoe", vendor: "V", type: "Shoe", tags: ["Red"], price: "20.00", available: true });
      await build(db, shop);

      const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "shoe not red" }));
      expect(r.interpretedAs.negationIgnored).toContain("red");
      expect(r.interpretedAs.warning).toBeTruthy();
      expect(r.interpretedAs.warning).toContain("red");
      // Negative filtering is NOT applied (never filters FOR red either).
      expect(r.appliedFilters.tags ?? []).not.toContain("Red");
      expect(r.appliedFilters.tags ?? []).not.toContain("red");
    });
  });

  // --- A4: control characters (NUL) stripped in the shared normalization path ---
  describe("A4 — control-character safety", () => {
    it("a NUL-containing query returns normally with nl true and false", async () => {
      const shop = await db.resolveShop("a4.myshopify.com");
      await seed(db, shop, { gid: "1", title: "Red Shoe", vendor: "Nike", type: "Shoe", tags: ["Red"], price: "50.00", available: true });
      await build(db, shop);

      const hostile = "red\u0000 shoe"; // embedded NUL that used to crash PostgreSQL
      const withNl = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: hostile, nl: true }));
      expect(withNl.total).toBeGreaterThan(0);
      const noNl = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: hostile, nl: false }));
      expect(noNl.total).toBeGreaterThan(0);
      // NUL in a free-text filter value is also harmless.
      const filtered = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "shoe", filters: { vendor: "Nike\u0000" }, nl: false }));
      expect(filtered.total).toBeGreaterThan(0);
    });
  });

  // --- NL == manual-equivalent (products, total, facets) ---
  describe("NL result equals the manual-equivalent filters", () => {
    it("parsed query matches the same explicit filters (products, total, facets)", async () => {
      const shop = await db.resolveShop("eq.myshopify.com");
      await seed(db, shop, { gid: "1", title: "Red Running Shoe", vendor: "Nike", type: "Shoe", tags: ["Red"], price: "50.00", available: true });
      await seed(db, shop, { gid: "2", title: "Red Sandal", vendor: "Adidas", type: "Sandal", tags: ["Red"], price: "30.00", available: true });
      await seed(db, shop, { gid: "3", title: "Blue Shoe", vendor: "Nike", type: "Shoe", tags: ["Blue"], price: "80.00", available: true });
      await build(db, shop);

      const nl = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "red shoe" }));
      // Manual equivalent: the live-cased tag + product type the parser resolved.
      const manual = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, {
        q: "", nl: false, filters: { tags: ["Red"], productType: ["Shoe"] },
      }));

      expect(nl.products.map((p) => p.id)).toEqual(manual.products.map((p) => p.id));
      expect(nl.total).toBe(manual.total);
      const norm = (fs: any[]) => fs.map((f) => ({ key: f.key, opts: f.options.map((o: any) => [o.value, o.count]).sort() })).sort((a, b) => a.key.localeCompare(b.key));
      expect(norm(nl.facets)).toEqual(norm(manual.facets));
    });
  });
});
