import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant, upsertCollection, replaceProductCollectionsByGids } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { getRecommendations } from "~/lib/recommend/engine";
import { saveSettings } from "~/lib/recommend/settings";
import { recordSignal } from "~/lib/recommend/signals";
import { rebuildCooccurrence, SyntheticBasketSource } from "~/lib/recommend/cooccurrence";
import { createRule } from "~/lib/merch/rules";

/*
 * Phase 9 — orchestrator (getRecommendations): type switching, settings gates,
 * FBT fallback, recently-viewed listing, global hide, no-active. Migration 0011
 * must be applied to the test DB.
 */
const G = (n: number) => `gid://shopify/Product/${n}`;
const handleOf = (gid: string) => gid.split("/").pop()!;
const COL = { gid: "gid://shopify/Collection/1", title: "Shelf" };

async function seed(db: TestDb, shop: string, gid: string, title: string, available = true) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: gid, title, handle: handleOf(gid), vendor: "V", productType: "T", tags: ["t"],
      status: "ACTIVE", onlineStoreUrl: `https://shop.example/products/${handleOf(gid)}`,
      featuredImageUrl: `https://cdn.shopify.com/${handleOf(gid)}.jpg`, metafields: {}, productCreatedAt: "2024-0" + (gid.length % 9 + 1) + "-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: gid + "/v", sku: "S" + handleOf(gid), price: "10", availableForSale: available });
    await upsertCollection(e, shop, { shopifyCollectionGid: COL.gid, title: COL.title, handle: "shelf" });
    await replaceProductCollectionsByGids(e, shop, id, [COL.gid]);
  });
}
async function build(db: TestDb, shop: string): Promise<string> {
  const n = await db.withShopExec(shop, async (e) =>
    (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  return v.id;
}

describe("Phase 9 — getRecommendations orchestrator", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p9e.myshopify.com");
    for (let i = 1; i <= 4; i++) await seed(db, shop, G(i), "Prod " + i);
    await build(db, shop);
  });
  const run = (req: any) => db.withShopExec(shop, (e) => getRecommendations(e, shop, req));

  it("similar returns ranked products and excludes the seed", async () => {
    const r = await run({ type: "similar", seed: G(1), limit: 12 });
    expect(r.type).toBe("similar");
    expect(r.products.length).toBeGreaterThan(0);
    expect(r.products.find((p) => p.gid === G(1))).toBeUndefined();
  });

  it("disabled shelf returns empty with reason", async () => {
    await db.withShopExec(shop, (e) => saveSettings(e, shop, { similarEnabled: false }));
    const r = await run({ type: "similar", seed: G(1) });
    expect(r.products).toEqual([]);
    expect(r.reason).toBe("disabled");
  });

  it("fbt with no data and fallback on → related products (fellBackTo=related)", async () => {
    const r = await run({ type: "fbt", seed: G(1) });
    expect(r.fellBackTo).toBe("related");
    expect(r.products.length).toBeGreaterThan(0);
  });

  it("fbt enabled with co-occurrence data returns FBT (no fallback)", async () => {
    const v = await db.withShopExec(shop, async (e) =>
      (await e.rows<{ id: string }>("SELECT id FROM index_version WHERE shop_id=$1::uuid AND status='active'", [shop]))[0].id);
    await db.withShopExec(shop, (e) => saveSettings(e, shop, { fbtEnabled: true }));
    await db.withShopExec(shop, (e) => rebuildCooccurrence(e, shop, v, new SyntheticBasketSource([
      [G(1), G(2)], [G(1), G(2)], [G(1), G(2)],
    ]), {}));
    const r = await run({ type: "fbt", seed: G(1), limit: 12 });
    expect(r.fellBackTo).toBeNull();
    expect(r.products.map((p) => p.gid)).toEqual([G(2)]);
  });

  it("recent lists the viewed products in order, excluding the current seed", async () => {
    const r = await run({ type: "recent", seed: G(1), recent: `${G(3)},${G(1)},${G(2)}` });
    // G(1) is the seed → excluded; order preserved
    expect(r.products.map((p) => p.gid)).toEqual([G(3), G(2)]);
  });

  it("trending uses signals then tops up with newest", async () => {
    const v = await db.withShopExec(shop, async (e) =>
      (await e.rows<{ id: string }>("SELECT id FROM index_version WHERE shop_id=$1::uuid AND status='active'", [shop]))[0].id);
    await db.withShopExec(shop, (e) => recordSignal(e, shop, v, G(2), "click"));
    const r = await run({ type: "trending", limit: 4 });
    expect(r.products[0].gid).toBe(G(2)); // signalled product leads
    expect(r.products.length).toBe(4);    // topped up to the limit
  });

  it("a globally-hidden product is never recommended", async () => {
    await db.withShopExec(shop, (e) => createRule(e, shop, {
      action: "hide", scopeType: "global", targets: [{ kind: "gid", value: G(2) }],
    }));
    const r = await run({ type: "similar", seed: G(1), limit: 12 });
    expect(r.products.find((p) => p.gid === G(2))).toBeUndefined();
  });

  it("no active index version → empty with reason", async () => {
    const other = await db.resolveShop("p9e-empty.myshopify.com");
    const r = await db.withShopExec(other, (e) => getRecommendations(e, other, { type: "trending" }));
    expect(r.products).toEqual([]);
    expect(r.reason).toBe("no-active");
  });
});
