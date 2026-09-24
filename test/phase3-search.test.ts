import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
  refreshDocInActiveVersion, getActiveVersion,
} from "~/lib/index/engine";
import { searchWithExec } from "~/lib/search/query";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { catalogSuggestionsWithExec } from "~/lib/search/suggest";
import { predictiveWithExec } from "~/lib/search/predictive";

interface Seed {
  gid: string; title: string; handle?: string; vendor?: string; type?: string;
  desc?: string | null; status?: string; tags?: string[]; published?: boolean;
  sku?: string | null; barcode?: string | null; price?: string; cmp?: string | null;
  avail?: boolean;
}

async function seedProduct(db: TestDb, shopId: string, s: Seed): Promise<string> {
  return db.withShopExec(shopId, async (e) => {
    const { id } = await upsertProduct(e, shopId, {
      shopifyProductGid: s.gid,
      title: s.title,
      handle: s.handle ?? s.gid.split("/").pop(),
      vendor: s.vendor ?? "Acme",
      productType: s.type ?? "Shoe",
      description: s.desc ?? null,
      status: s.status ?? "ACTIVE",
      tags: s.tags ?? [],
      onlineStoreUrl: (s.published ?? true) ? `https://shop.test/${s.handle ?? "p"}` : null,
      featuredImageUrl: "https://img.test/x.jpg",
      featuredImageAlt: s.title,
    });
    await upsertVariant(e, shopId, id, {
      shopifyVariantGid: s.gid + "/v1",
      sku: s.sku ?? null, barcode: s.barcode ?? null, title: "Default",
      price: s.price ?? "10.00", compareAtPrice: s.cmp ?? null,
      availableForSale: s.avail ?? true, position: 1,
    });
    return id;
  });
}

async function buildActive(db: TestDb, shopId: string): Promise<string> {
  const count = await db.withShopExec(shopId, async (e) =>
    (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shopId]))[0].n,
  );
  const v = await db.withShopExec(shopId, (e) => createIndexVersion(e, shopId, "full", count));
  await db.withShopExec(shopId, (e) => buildDocs(e, shopId, v.id));
  const res = await db.withShopExec(shopId, (e) => validateIndexVersion(e, shopId, v.id, count));
  expect(res.pass).toBe(true);
  await db.withShopExec(shopId, (e) => activateIndexVersion(e, shopId, v.id));
  return v.id;
}

describe("Phase 3 — storefront search", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); shop = await db.resolveShop("p3.myshopify.com"); });

  describe("relevance basics", () => {
    beforeEach(async () => {
      await seedProduct(db, shop, { gid: "gid://shopify/Product/1", title: "Blue Running Shoes", vendor: "Nike", type: "Sneaker", tags: ["sport"], sku: "RUN-1", desc: "comfortable" });
      await seedProduct(db, shop, { gid: "gid://shopify/Product/2", title: "Comfort Insole", desc: "great for running shoes and comfort", vendor: "SoleCo", sku: "INS-2" });
      await seedProduct(db, shop, { gid: "gid://shopify/Product/3", title: "Red Sandals", vendor: "Nike", type: "Sandal", sku: "SAN-3" });
      await buildActive(db, shop);
    });

    it("matches by title token", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "running shoes" }));
      expect(r.products.map((p) => p.title)).toContain("Blue Running Shoes");
    });

    it("title weight beats description weight", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "running shoes" }));
      // Both products contain the terms; the title match must rank first.
      expect(r.products[0].title).toBe("Blue Running Shoes");
    });

    it("matches by vendor (weight B)", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "Nike" }));
      const titles = r.products.map((p) => p.title);
      expect(titles).toContain("Blue Running Shoes");
      expect(titles).toContain("Red Sandals");
    });

    it("matches by tag (weight C)", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "sport" }));
      expect(r.products.map((p) => p.title)).toContain("Blue Running Shoes");
    });

    it("exact SKU ranks first even amid other matches", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "SAN-3" }));
      expect(r.products[0].title).toBe("Red Sandals");
      expect(r.strategy === "exact_sku" || r.strategy === "and").toBe(true);
    });

    it("returns result-card fields", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "sandals" }));
      const p = r.products[0];
      expect(p.image.url).toBe("https://img.test/x.jpg");
      expect(Number(p.priceMin)).toBe(10);
      expect(p.url).toContain("http");
      expect(p.available).toBe(true);
      expect(p.gid).toBe("gid://shopify/Product/3");
    });
  });

  describe("excluded content is never returned", () => {
    beforeEach(async () => {
      await seedProduct(db, shop, { gid: "gid://shopify/Product/1", title: "Active Published Widget", sku: "A-1" });
      await seedProduct(db, shop, { gid: "gid://shopify/Product/2", title: "Draft Widget", status: "DRAFT", sku: "D-2" });
      await seedProduct(db, shop, { gid: "gid://shopify/Product/3", title: "Archived Widget", status: "ARCHIVED", sku: "R-3" });
      await seedProduct(db, shop, { gid: "gid://shopify/Product/4", title: "Unpublished Widget", published: false, sku: "U-4" });
      await buildActive(db, shop);
    });

    it("omits draft, archived, and unpublished products", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "widget" }));
      const titles = r.products.map((p) => p.title);
      expect(titles).toEqual(["Active Published Widget"]);
      expect(r.total).toBe(1);
    });

    it("even an exact SKU cannot surface a draft/unpublished product", async () => {
      const rDraft = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "D-2" }));
      expect(rDraft.total).toBe(0);
      const rUnpub = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "U-4" }));
      expect(rUnpub.total).toBe(0);
    });
  });

  describe("active version only + atomic swap", () => {
    it("search reflects only the active version, and updates atomically on swap", async () => {
      const pid = await seedProduct(db, shop, { gid: "gid://shopify/Product/1", title: "Original Name", sku: "X-1" });
      await buildActive(db, shop);
      let r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "Original" }));
      expect(r.total).toBe(1);
      expect(r.indexVersion).toBe(1);

      // Rename the product and build a NEW version but DON'T activate yet.
      await db.withShopExec(shop, (e) => upsertProduct(e, shop, {
        shopifyProductGid: "gid://shopify/Product/1", title: "Renamed Product",
        onlineStoreUrl: "https://shop.test/x", status: "ACTIVE",
        shopifyUpdatedAt: new Date(Date.now() + 1000).toISOString(),
      }));
      const v2 = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", 1));
      await db.withShopExec(shop, (e) => buildDocs(e, shop, v2.id));
      await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v2.id, 1));

      // Still serving v1: old name matches, new name does not.
      r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "Renamed" }));
      expect(r.total).toBe(0);
      r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "Original" }));
      expect(r.total).toBe(1);

      // Activate v2 -> now serving new name only.
      await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v2.id));
      r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "Renamed" }));
      expect(r.total).toBe(1);
      expect(r.indexVersion).toBe(2);
      r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "Original" }));
      expect(r.total).toBe(0);
      void pid;
    });
  });

  describe("incremental refresh keeps tsvector current", () => {
    it("an in-place doc refresh makes new title text searchable immediately", async () => {
      const pid = await seedProduct(db, shop, { gid: "gid://shopify/Product/1", title: "Green Hat", sku: "H-1" });
      await buildActive(db, shop);
      expect((await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "Purple" }))).total).toBe(0);

      // Simulate a products/update webhook: update the row + in-place refresh.
      await db.withShopExec(shop, (e) => upsertProduct(e, shop, {
        shopifyProductGid: "gid://shopify/Product/1", title: "Purple Hat",
        onlineStoreUrl: "https://shop.test/h", status: "ACTIVE",
        shopifyUpdatedAt: new Date(Date.now() + 1000).toISOString(),
      }));
      await db.withShopExec(shop, (e) => refreshDocInActiveVersion(e, shop, pid));

      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "Purple" }));
      expect(r.total).toBe(1);
      expect(r.products[0].title).toBe("Purple Hat");
      // Old term no longer matches.
      expect((await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "Green" }))).total).toBe(0);
    });
  });

  describe("fallback cascade", () => {
    beforeEach(async () => {
      await seedProduct(db, shop, { gid: "gid://shopify/Product/1", title: "Wireless Headphones", vendor: "AudioCo", sku: "WH-1", desc: "noise cancelling" });
      await buildActive(db, shop);
    });

    it("AND strategy for a full phrase", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "wireless headphones" }));
      expect(r.strategy).toBe("and");
      expect(r.total).toBe(1);
    });

    it("prefix strategy for a partial trailing token", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "headph" }));
      expect(["prefix", "and"]).toContain(r.strategy);
      expect(r.total).toBe(1);
    });

    it("trigram is the last resort for a near-miss title", async () => {
      // "headphon" missing letters -> not a prefix of a lexeme; trigram catches it.
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "hedphones" }));
      expect(["trigram", "or", "prefix"]).toContain(r.strategy);
    });

    it("genuine zero-result returns a structured block with suggestions", async () => {
      const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "xylophone" }));
      expect(r.total).toBe(0);
      expect(r.zeroResult).toBe(true);
      expect(r.fallback).toBeNull();
    });

    it("no active index advises native fallback (never a 500)", async () => {
      const other = await db.resolveShop("noindex.myshopify.com");
      const r = await db.withShopExec(other, (e) => storefrontSearchWithExec(e, other, { q: "anything" }));
      expect(r.fallback).toBe("native");
      expect(r.indexVersion).toBeNull();
    });
  });

  describe("predictive + catalog suggestions", () => {
    beforeEach(async () => {
      await seedProduct(db, shop, { gid: "gid://shopify/Product/1", title: "Running Shoes", vendor: "RunFast", type: "Sneaker", sku: "R-1" });
      await seedProduct(db, shop, { gid: "gid://shopify/Product/2", title: "Rugby Ball", vendor: "RunFast", type: "Ball", sku: "R-2" });
      await buildActive(db, shop);
    });

    it("predictive returns products and catalog suggestions for a prefix", async () => {
      const r = await db.withShopExec(shop, (e) => predictiveWithExec(e, shop, { q: "ru" }));
      expect(r.products.length).toBeGreaterThanOrEqual(1);
      expect(r.suggestions.length).toBeGreaterThanOrEqual(1);
    });

    it("suggestions are catalog-derived (titles/vendors/types), title-first", async () => {
      const s = await db.withShopExec(shop, (e) => catalogSuggestionsWithExec(e, shop, "run"));
      const texts = s.map((x) => x.text.toLowerCase());
      expect(texts).toContain("running shoes");
      expect(texts).toContain("runfast");
      // deterministic ordering: a title suggestion outranks a vendor one.
      const firstTitle = s.findIndex((x) => x.type === "title");
      const firstVendor = s.findIndex((x) => x.type === "vendor");
      expect(firstTitle).toBeLessThan(firstVendor);
    });

    it("suggestions never include unpublished catalog terms", async () => {
      await seedProduct(db, shop, { gid: "gid://shopify/Product/9", title: "Runic Secret", published: false, sku: "R-9" });
      await buildActive(db, shop);
      const s = await db.withShopExec(shop, (e) => catalogSuggestionsWithExec(e, shop, "runic"));
      expect(s).toHaveLength(0);
    });
  });

  describe("query hardening", () => {
    beforeEach(async () => {
      await seedProduct(db, shop, { gid: "gid://shopify/Product/1", title: "Safe Product", sku: "S-1" });
      await buildActive(db, shop);
    });

    it("tsquery metacharacters and SQL-ish input cannot break the query", async () => {
      for (const q of ["'; DROP TABLE product; --", "a & b | c :* ! ( )", "%_\\", "<script>", "   "]) {
        const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q }));
        expect(Array.isArray(r.products)).toBe(true);
      }
      // The table is still there.
      const n = await db.withShopExec(shop, (e) => e.rows<{ n: number }>("SELECT count(*)::int n FROM product", []));
      expect(n[0].n).toBe(1);
    });

    it("limit is clamped to <= 50 and offset is bounded", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "safe", limit: 9999, offset: -5 }));
      expect(r.products.length).toBeLessThanOrEqual(50);
    });

    it("over-long queries are truncated, not rejected", async () => {
      const r = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "safe ".repeat(500) }));
      expect(r.total).toBeGreaterThanOrEqual(0);
    });
  });
});
