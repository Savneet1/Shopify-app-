import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { recordSignal } from "~/lib/recommend/signals";
import { rebuildCooccurrence, SyntheticBasketSource } from "~/lib/recommend/cooccurrence";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "~/lib/recommend/settings";

/*
 * Phase 9 — RLS + cross-shop isolation on every new tenant table, plus settings
 * load/save. Migration 0011 must be applied to the test DB.
 */
const G = (n: number) => `gid://shopify/Product/${n}`;
const handleOf = (gid: string) => gid.split("/").pop()!;

async function seedAndBuild(db: TestDb, shop: string, gid: string): Promise<string> {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: gid, title: "P-" + handleOf(gid), handle: handleOf(gid), vendor: "V", productType: "T",
      tags: [], status: "ACTIVE", onlineStoreUrl: `https://shop.example/products/${handleOf(gid)}`, metafields: {},
      productCreatedAt: "2024-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: gid + "/v", sku: "S-" + handleOf(gid), price: "10", availableForSale: true });
  });
  const n = await db.withShopExec(shop, async (e) =>
    (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  return v.id;
}

describe("Phase 9 — RLS + cross-shop isolation", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p9a.myshopify.com");
    shopB = await db.resolveShop("p9b.myshopify.com");
  });

  it("RLS is enabled on every Phase 9 tenant table", async () => {
    const { rows } = await db.runtimePool.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
       AND tablename IN ('product_signal_daily','product_cooccurrence','product_cooccurrence_build','recommendation_settings')`,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.rowsecurity).toBe(true);
  });

  it("signals written by shop A are invisible to shop B", async () => {
    const vA = await seedAndBuild(db, shopA, G(1));
    await seedAndBuild(db, shopB, G(1));
    await db.withShopExec(shopA, (e) => recordSignal(e, shopA, vA, G(1), "click"));
    const aRows = await db.withShopExec(shopA, (e) => e.rows("SELECT * FROM product_signal_daily"));
    const bRows = await db.withShopExec(shopB, (e) => e.rows("SELECT * FROM product_signal_daily"));
    expect(aRows.length).toBe(1);
    expect(bRows.length).toBe(0);
  });

  it("co-occurrence written by shop A is invisible to shop B", async () => {
    const vA = await seedAndBuild(db, shopA, G(1));
    await db.withShopExec(shopA, async (e) => { await upsertProduct(e, shopA, { shopifyProductGid: G(2), title: "P2", handle: "2", vendor: "V", productType: "T", tags: [], status: "ACTIVE", onlineStoreUrl: "https://shop.example/products/2", metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z" }); });
    // rebuild on the already-active version is fine for isolation purposes
    await db.withShopExec(shopA, (e) => rebuildCooccurrence(e, shopA, vA, new SyntheticBasketSource([[G(1)], [G(1)]]), {}));
    const aRows = await db.withShopExec(shopA, (e) => e.rows("SELECT * FROM product_cooccurrence"));
    const bRows = await db.withShopExec(shopB, (e) => e.rows("SELECT * FROM product_cooccurrence"));
    const aBuild = await db.withShopExec(shopA, (e) => e.rows("SELECT * FROM product_cooccurrence_build"));
    const bBuild = await db.withShopExec(shopB, (e) => e.rows("SELECT * FROM product_cooccurrence_build"));
    expect(aRows.length).toBeGreaterThan(0);
    expect(bRows.length).toBe(0);
    expect(aBuild.length).toBe(1);
    expect(bBuild.length).toBe(0);
  });

  it("settings are per-shop: defaults until saved, isolated after", async () => {
    const a0 = await db.withShopExec(shopA, (e) => loadSettings(e, shopA));
    expect(a0).toEqual(DEFAULT_SETTINGS);
    await db.withShopExec(shopA, (e) => saveSettings(e, shopA, { fbtEnabled: true, diversifyPerVendor: 3, trendingHalfLifeDays: 14 }));
    const a1 = await db.withShopExec(shopA, (e) => loadSettings(e, shopA));
    expect(a1.fbtEnabled).toBe(true);
    expect(a1.diversifyPerVendor).toBe(3);
    expect(a1.trendingHalfLifeDays).toBe(14);
    // shop B still sees defaults and cannot see A's row
    const b0 = await db.withShopExec(shopB, (e) => loadSettings(e, shopB));
    expect(b0).toEqual(DEFAULT_SETTINGS);
    const bRows = await db.withShopExec(shopB, (e) => e.rows("SELECT * FROM recommendation_settings"));
    expect(bRows.length).toBe(0);
  });

  it("settings save clamps out-of-range values", async () => {
    const s = await db.withShopExec(shopA, (e) => saveSettings(e, shopA, { diversifyPerVendor: 999, trendingHalfLifeDays: 0 }));
    expect(s.diversifyPerVendor).toBe(24); // clamped to max
    expect(s.trendingHalfLifeDays).toBe(1); // clamped up to the minimum (1 day)
  });
});
