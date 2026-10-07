import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
} from "~/lib/index/engine";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { addAttributeTerm, listAttributeTerms } from "~/lib/search/attributes";

interface Seed {
  gid: string; title: string; vendor: string; type: string; tags: string[];
  price: string; available: boolean; material?: string; created: string;
}
async function seed(db: TestDb, shop: string, s: Seed) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: s.gid, title: s.title, handle: s.gid, vendor: s.vendor, productType: s.type,
      tags: s.tags, status: "ACTIVE", onlineStoreUrl: `https://x/${s.gid}`,
      metafields: s.material ? { "custom.material": s.material } : {}, productCreatedAt: s.created,
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

const CAT: Seed[] = [
  { gid: "1", title: "Red Running Shoe", vendor: "Nike", type: "Shoe", tags: ["red"], price: "50.00", available: true, material: "leather", created: "2024-01-01T00:00:00Z" },
  { gid: "2", title: "Blue Running Shoe", vendor: "Nike", type: "Shoe", tags: ["blue"], price: "80.00", available: true, created: "2024-06-01T00:00:00Z" },
  { gid: "3", title: "Red Sandals", vendor: "Adidas", type: "Sandal", tags: ["red"], price: "30.00", available: false, created: "2024-03-01T00:00:00Z" },
  { gid: "4", title: "Green Boots", vendor: "Puma", type: "Boot", tags: ["green"], price: "120.00", available: true, created: "2024-09-01T00:00:00Z" },
];

describe("Phase 6 — NL semantic layer", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p6.myshopify.com");
    for (const s of CAT) await seed(db, shop, s);
    await build(db, shop);
  });
  const sf = (params: any) => db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, params));

  it("parses attribute + product type and returns the right products", async () => {
    const r = await sf({ q: "red shoe" });
    expect(r.interpretedAs.applied).toBe(true);
    expect(r.products.map((p) => p.title)).toEqual(["Red Running Shoe"]);
    expect(r.appliedFilters.tags).toContain("red");
    expect(r.appliedFilters.productType).toContain("Shoe");
  });

  it("parses brand + price phrase", async () => {
    const r = await sf({ q: "Nike under 60" });
    expect(r.appliedFilters.vendor).toContain("Nike");
    expect(r.appliedFilters.priceMax).toBe(60);
    expect(r.products.map((p) => p.title)).toEqual(["Red Running Shoe"]); // Nike @ 50; the 80 one excluded
  });

  it("facet counts stay consistent with the parsed result set", async () => {
    const r = await sf({ q: "red" }); // tags=red -> P1, P3
    expect(r.total).toBe(2);
    const vendor = r.facets.find((f) => f.key === "vendor");
    // vendor facet excludes its own group; over tags=red that is Nike(1)+Adidas(1)
    expect(vendor?.options.find((o) => o.value === "Nike")?.count).toBe(1);
    expect(vendor?.options.find((o) => o.value === "Adidas")?.count).toBe(1);
    expect(vendor?.options.find((o) => o.value === "Puma")).toBeUndefined();
  });

  it("sort hints: newest uses product createdAt; cheapest sorts by price", async () => {
    const newest = await sf({ q: "newest" });
    expect(newest.sort).toBe("newest");
    expect(newest.products[0].title).toBe("Green Boots"); // 2024-09
    const cheap = await sf({ q: "cheapest" });
    expect(cheap.sort).toBe("price_asc");
    expect(cheap.products[0].title).toBe("Red Sandals"); // 30
  });

  it("never worse than Phase 5: parsed zero-result falls back to plain search", async () => {
    const r = await sf({ q: "Nike sandals" }); // NL: vendor=Nike + 'sandals' -> 0 Nike sandals
    expect(r.interpretedAs.applied).toBe(true);
    expect(r.interpretedAs.fellBack).toBe(true);
    expect(r.total).toBeGreaterThan(0); // plain partial-match recall
  });

  it("nl=false disables parsing (plain Phase 5)", async () => {
    const r = await sf({ q: "red shoe", nl: false });
    expect(r.interpretedAs.applied).toBe(false);
    expect(r.appliedFilters.tags ?? []).not.toContain("red"); // no parsed filter
  });

  it("ignore drops a single interpretation (price not interpreted)", async () => {
    const r = await sf({ q: "red under 50", ignore: ["price"] });
    // price was ignored by the parser; the attribute was still interpreted.
    expect(r.interpretedAs.interpreted.some((i) => i.kind === "price")).toBe(false);
    expect(r.interpretedAs.interpreted.some((i) => i.kind === "attribute" && i.text === "red")).toBe(true);
  });

  it("negation is suppressed, not inverted (never filters for the excluded term)", async () => {
    const r = await sf({ q: "shoe not red" });
    expect(r.appliedFilters.tags ?? []).not.toContain("red");
    expect(r.interpretedAs.negations).toContain("red");
  });

  it("parsed filters pass the same validation; hostile input never reaches SQL raw", async () => {
    const r = await sf({ q: "red '; DROP TABLE product; --" });
    expect(r.interpretedAs.interpreted.some((i) => i.kind === "attribute" && i.text === "red")).toBe(true);
    const n = await db.withShopExec(shop, (e) => e.rows<{ n: number }>("SELECT count(*)::int n FROM product", []));
    expect(n[0].n).toBe(4); // table intact — no SQL injection
  });

  describe("per-shop dictionary + RLS + cross-shop isolation", () => {
    it("a shop's attribute override applies to its own parse only", async () => {
      await db.withShopExec(shop, (e) => addAttributeTerm(e, shop, "crimson", "tags", "red"));
      const mine = await sf({ q: "crimson" });
      expect(mine.appliedFilters.tags).toContain("red");

      const other = await db.resolveShop("p6-other.myshopify.com");
      await db.withShopExec(other, async (e) => {
        const { id } = await upsertProduct(e, other, { shopifyProductGid: "z1", title: "Zeta Widget", vendor: "Zeta", productType: "Gadget", status: "ACTIVE", onlineStoreUrl: "https://z/1" });
        await upsertVariant(e, other, id, { shopifyVariantGid: "z1/v", sku: "Z1", price: "9.00", availableForSale: true });
      });
      await build(db, other);
      // other shop does NOT see this shop's "crimson" override or "Nike" vendor
      const theirs = await db.withShopExec(other, (e) => storefrontSearchWithExec(e, other, { q: "crimson Nike" }));
      expect(theirs.appliedFilters.tags ?? []).not.toContain("red");
      expect(theirs.appliedFilters.vendor ?? []).not.toContain("Nike");
      // attribute table is RLS-isolated
      const cnt = await db.withShopExec(other, (e) => e.rows<{ n: number }>("SELECT count(*)::int n FROM search_attribute_term", []));
      expect(cnt[0].n).toBe(0);
      const mineRows = await db.withShopExec(shop, (e) => listAttributeTerms(e, shop));
      expect(mineRows).toHaveLength(1);
    });
  });
});
