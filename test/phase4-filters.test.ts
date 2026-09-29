import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant, upsertCollection, replaceProductCollectionsByGids } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
} from "~/lib/index/engine";
import { searchWithExec } from "~/lib/search/query";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { normalizeFilters, FilterValidationError } from "~/lib/search/filters";
import type { Facet } from "~/lib/search/facets";

interface Seed {
  gid: string; title: string; vendor: string; type: string; tags: string[];
  price: string; available: boolean; material?: string; status?: string;
  published?: boolean; collections?: string[];
}

async function seed(db: TestDb, shopId: string, s: Seed): Promise<string> {
  return db.withShopExec(shopId, async (e) => {
    const metafields: Record<string, string> = s.material ? { "custom.material": s.material } : {};
    const { id } = await upsertProduct(e, shopId, {
      shopifyProductGid: s.gid, title: s.title, handle: s.gid.split("/").pop(),
      vendor: s.vendor, productType: s.type, status: s.status ?? "ACTIVE",
      tags: s.tags, onlineStoreUrl: (s.published ?? true) ? `https://shop.test/${s.title}` : null,
      featuredImageUrl: "https://img.test/x.jpg", featuredImageAlt: s.title, metafields,
    });
    await upsertVariant(e, shopId, id, {
      shopifyVariantGid: s.gid + "/v1", sku: "SKU-" + s.gid.split("/").pop(),
      price: s.price, availableForSale: s.available, position: 1,
    });
    for (const cg of s.collections ?? []) {
      await upsertCollection(e, shopId, { shopifyCollectionGid: cg, title: cg.split("/").pop(), handle: cg.split("/").pop() });
      await replaceProductCollectionsByGids(e, shopId, id, s.collections!);
    }
    return id;
  });
}

async function buildActive(db: TestDb, shopId: string): Promise<string> {
  const n = await db.withShopExec(shopId, async (e) =>
    (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shopId]))[0].n);
  const v = await db.withShopExec(shopId, (e) => createIndexVersion(e, shopId, "full", n));
  await db.withShopExec(shopId, (e) => buildDocs(e, shopId, v.id));
  const res = await db.withShopExec(shopId, (e) => validateIndexVersion(e, shopId, v.id, n));
  expect(res.pass).toBe(true);
  await db.withShopExec(shopId, (e) => activateIndexVersion(e, shopId, v.id));
  return v.id;
}

function facet(facets: Facet[], key: string): Facet | undefined {
  return facets.find((f) => f.key === key);
}
function count(facets: Facet[], key: string, value: string): number {
  const opt = facet(facets, key)?.options.find((o) => o.value === value);
  return opt?.count ?? 0;
}

const CATALOG: Seed[] = [
  { gid: "gid://shopify/Product/1", title: "P1", vendor: "Nike", type: "Shoe", tags: ["red", "sport"], price: "50.00", available: true, material: "Leather", collections: ["gid://shopify/Collection/A"] },
  { gid: "gid://shopify/Product/2", title: "P2", vendor: "Nike", type: "Sandal", tags: ["red"], price: "30.00", available: true, material: "Rubber", collections: ["gid://shopify/Collection/A"] },
  { gid: "gid://shopify/Product/3", title: "P3", vendor: "Adidas", type: "Shoe", tags: ["blue", "sport"], price: "80.00", available: false, material: "Leather", collections: ["gid://shopify/Collection/B"] },
  { gid: "gid://shopify/Product/4", title: "P4", vendor: "Puma", type: "Shoe", tags: ["green"], price: "20.00", available: true, material: "Canvas" },
  { gid: "gid://shopify/Product/5", title: "DraftShoe", vendor: "Nike", type: "Shoe", tags: ["red"], price: "99.00", available: true, material: "Leather", status: "DRAFT" },
  { gid: "gid://shopify/Product/6", title: "UnpubShoe", vendor: "Nike", type: "Shoe", tags: ["red"], price: "99.00", available: true, material: "Leather", published: false },
];

describe("Phase 4 — filters & facets", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p4.myshopify.com");
    for (const s of CATALOG) await seed(db, shop, s);
    await buildActive(db, shop);
  });

  const sf = (params: any) => db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, params));

  it("browse mode (no query) returns all visible products + facets", async () => {
    const r = await sf({ q: "" });
    expect(r.total).toBe(4); // 4 visible; draft + unpublished excluded
    expect(r.strategy).toBe("browse");
    expect(count(r.facets, "vendor", "Nike")).toBe(2);
    expect(count(r.facets, "vendor", "Adidas")).toBe(1);
    expect(count(r.facets, "productType", "Shoe")).toBe(3);
    expect(count(r.facets, "tags", "sport")).toBe(2);
    expect(count(r.facets, "available", "true")).toBe(3);
    expect(count(r.facets, "available", "false")).toBe(1);
    expect(count(r.facets, "material", "Leather")).toBe(2);
    expect(r.priceRange).toEqual({ min: "20.00", max: "80.00" });
  });

  it("a facet's own selection does NOT zero its own counts", async () => {
    const r = await sf({ q: "", filters: { vendor: ["Nike"] } });
    expect(r.total).toBe(2); // products narrowed to Nike
    // vendor facet EXCLUDES its own filter -> all vendors still counted:
    expect(count(r.facets, "vendor", "Nike")).toBe(2);
    expect(count(r.facets, "vendor", "Adidas")).toBe(1);
    expect(count(r.facets, "vendor", "Puma")).toBe(1);
    // other facets DO reflect vendor=Nike:
    expect(count(r.facets, "productType", "Shoe")).toBe(1); // only P1
    expect(count(r.facets, "productType", "Sandal")).toBe(1); // only P2
  });

  it("filters AND-combine across groups", async () => {
    const r = await sf({ q: "", filters: { vendor: ["Nike"], productType: ["Shoe"] } });
    expect(r.total).toBe(1); // P1 only
    expect(r.products[0].title).toBe("P1");
  });

  it("multi-value within a group is OR (two vendors -> either)", async () => {
    const r = await sf({ q: "", filters: { vendor: ["Adidas", "Puma"] } });
    expect(r.total).toBe(2); // P3 + P4
  });

  it("tags overlap (OR within group)", async () => {
    const r = await sf({ q: "", filters: { tags: ["sport"] } });
    expect(r.total).toBe(2); // P1 + P3
  });

  it("price range filter (overlap)", async () => {
    const r = await sf({ q: "", filters: { priceMin: "25", priceMax: "60" } });
    // P1 (50), P2 (30) in range; P3 (80) and P4 (20) out
    expect(r.products.map((p) => p.title).sort()).toEqual(["P1", "P2"]);
  });

  it("availability filter", async () => {
    const r = await sf({ q: "", filters: { available: "false" } });
    expect(r.products.map((p) => p.title)).toEqual(["P3"]);
  });

  it("metafield facet + filter (single-value exact match)", async () => {
    const r = await sf({ q: "", filters: { metafield: ["Leather"] } });
    expect(r.products.map((p) => p.title).sort()).toEqual(["P1", "P3"]);
    // facet excludes its own selection -> all materials still counted
    expect(count(r.facets, "material", "Rubber")).toBe(1);
  });

  it("collection-scoped facets + results only reflect that collection", async () => {
    const r = await sf({ q: "", filters: { collectionId: "gid://shopify/Collection/A" } });
    expect(r.total).toBe(2); // P1 + P2 only
    expect(count(r.facets, "vendor", "Nike")).toBe(2);
    expect(facet(r.facets, "vendor")?.options.find((o) => o.value === "Adidas")).toBeUndefined();
    expect(count(r.facets, "productType", "Shoe")).toBe(1); // P1 only within A
    expect(count(r.facets, "productType", "Sandal")).toBe(1); // P2
  });

  it("visibility holds under every filter (draft/unpublished never returned)", async () => {
    // These filters match the draft/unpublished Nike shoes too, but they must not appear.
    const combos = [
      { vendor: ["Nike"] },
      { productType: ["Shoe"] },
      { tags: ["red"] },
      { material: undefined as any, metafield: ["Leather"] },
      { available: "true" },
      { priceMin: "90" }, // draft/unpub priced 99
    ];
    for (const filters of combos) {
      const r = await sf({ q: "", filters });
      expect(r.products.map((p) => p.title)).not.toContain("DraftShoe");
      expect(r.products.map((p) => p.title)).not.toContain("UnpubShoe");
    }
  });

  it("text query + filters combine (search AND facets over same set)", async () => {
    // Give P1 and P3 a shared word; query it then filter by vendor.
    const r = await sf({ q: "shoe", filters: { vendor: ["Nike"] } });
    // 'shoe' matches product_type weight; Nike shoes = P1 only
    expect(r.products.map((p) => p.title)).toEqual(["P1"]);
  });

  describe("query hardening on filter params", () => {
    it("oversized arrays are rejected (400-class)", () => {
      const big = Array.from({ length: 51 }, (_, i) => "v" + i);
      expect(() => normalizeFilters({ vendor: big })).toThrow(FilterValidationError);
    });
    it("negative / inverted price rejected", () => {
      expect(() => normalizeFilters({ priceMin: "-5" })).toThrow(FilterValidationError);
      expect(() => normalizeFilters({ priceMin: "100", priceMax: "10" })).toThrow(FilterValidationError);
    });
    it("over-long value rejected", () => {
      expect(() => normalizeFilters({ vendor: ["x".repeat(101)] })).toThrow(FilterValidationError);
    });
    it("injection attempts are treated as literal values, never executed", async () => {
      const r = await sf({ q: "", filters: { vendor: ["'; DROP TABLE product; --"], metafield: ["\" OR 1=1 --"] } });
      expect(r.total).toBe(0); // no vendor matches that literal
      const n = await db.withShopExec(shop, (e) => e.rows<{ n: number }>("SELECT count(*)::int n FROM product", []));
      expect(n[0].n).toBe(6); // table intact
    });
  });

  it("cross-shop: filters cannot leak another shop's facet values", async () => {
    const other = await db.resolveShop("p4-other.myshopify.com");
    await seed(db, other, { gid: "gid://shopify/Product/X", title: "Secret", vendor: "SecretVendor", type: "Spy", tags: ["classified"], price: "5.00", available: true, material: "Vibranium" });
    await buildActive(db, other);
    const r = await sf({ q: "", filters: { vendor: ["SecretVendor"] } });
    expect(r.total).toBe(0);
    expect(facet(r.facets, "vendor")?.options.find((o) => o.value === "SecretVendor")).toBeUndefined();
    expect(facet(r.facets, "material")?.options.find((o) => o.value === "Vibranium")).toBeUndefined();
    // and the other shop sees ITS product under the same filter
    const ro = await db.withShopExec(other, (e) => storefrontSearchWithExec(e, other, { q: "", filters: { vendor: ["SecretVendor"] } }));
    expect(ro.total).toBe(1);
  });

  it("active-version-only holds under filtered queries (swap)", async () => {
    // v1 active. Filter vendor=Nike -> 2. Rebuild v2 with P1 vendor changed to Reebok.
    let r = await sf({ q: "", filters: { vendor: ["Nike"] } });
    expect(r.total).toBe(2);

    await db.withShopExec(shop, (e) => upsertProduct(e, shop, {
      shopifyProductGid: "gid://shopify/Product/1", title: "P1", vendor: "Reebok",
      productType: "Shoe", status: "ACTIVE", onlineStoreUrl: "https://shop.test/P1",
      tags: ["red", "sport"], shopifyUpdatedAt: new Date(Date.now() + 1000).toISOString(),
    }));
    const v2 = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", 6));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v2.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v2.id, 6));

    // Not yet activated -> still v1: Nike still 2.
    r = await sf({ q: "", filters: { vendor: ["Nike"] } });
    expect(r.total).toBe(2);
    expect(r.indexVersion).toBe(1);

    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v2.id));
    r = await sf({ q: "", filters: { vendor: ["Nike"] } });
    expect(r.total).toBe(1); // only P2 now
    expect(r.indexVersion).toBe(2);
    const rr = await sf({ q: "", filters: { vendor: ["Reebok"] } });
    expect(rr.total).toBe(1);
  });

  it("filtered search via searchWithExec (product path) matches storefront total", async () => {
    const s = await db.withShopExec(shop, (e) => searchWithExec(e, shop, { q: "", filters: { vendor: ["Nike"] } }));
    expect(s.total).toBe(2);
    expect(s.strategy).toBe("browse");
  });
});
