import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { recordSignal, purgeOldSignals, RETENTION_DAYS } from "~/lib/recommend/signals";
import { selectInstalledShops, runSignalRetention } from "~/lib/jobs/maintenance";

/*
 * Phase 9.1 K2 — product_signal_daily retention purge. node-postgres; migration
 * 0011 must be applied to the test DB.
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

const NOW = new Date("2026-06-01T12:00:00Z");
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86400_000);

describe("Phase 9.1 K2 — signal retention", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;
  let vA: string;
  let vB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p9rA.myshopify.com");
    vA = await seedAndBuild(db, shopA, G(1));
    shopB = await db.resolveShop("p9rB.myshopify.com");
    vB = await seedAndBuild(db, shopB, G(1));
  });

  const count = (shop: string) =>
    db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product_signal_daily WHERE shop_id=$1::uuid", [shop]))[0].n);

  it("deletes rows older than retention, keeps newer, leaves other shop untouched", async () => {
    // shop A: one row well past retention, one just inside it.
    await db.withShopExec(shopA, (e) => recordSignal(e, shopA, vA, G(1), "view", daysBefore(RETENTION_DAYS + 10)));
    await db.withShopExec(shopA, (e) => recordSignal(e, shopA, vA, G(1), "click", daysBefore(5)));
    // shop B: one old row that must NOT be touched by shop A's purge.
    await db.withShopExec(shopB, (e) => recordSignal(e, shopB, vB, G(1), "view", daysBefore(RETENTION_DAYS + 10)));
    expect(await count(shopA)).toBe(2);

    const deleted = await db.withShopExec(shopA, (e) => purgeOldSignals(e, shopA, { now: NOW }));
    expect(deleted).toBe(1);
    expect(await count(shopA)).toBe(1); // the in-retention row survives
    expect(await count(shopB)).toBe(1); // other shop untouched
  });

  it("a second run is a no-op (idempotent)", async () => {
    await db.withShopExec(shopA, (e) => recordSignal(e, shopA, vA, G(1), "view", daysBefore(RETENTION_DAYS + 30)));
    const first = await db.withShopExec(shopA, (e) => purgeOldSignals(e, shopA, { now: NOW }));
    const second = await db.withShopExec(shopA, (e) => purgeOldSignals(e, shopA, { now: NOW }));
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("batching deletes everything over multiple bounded runs", async () => {
    // 5 distinct expired days for the same product.
    for (let i = 1; i <= 5; i++) {
      await db.withShopExec(shopA, (e) => recordSignal(e, shopA, vA, G(1), "view", daysBefore(RETENTION_DAYS + i)));
    }
    expect(await count(shopA)).toBe(5);
    let loops = 0;
    for (;;) {
      const n = await db.withShopExec(shopA, (e) => purgeOldSignals(e, shopA, { now: NOW, batchSize: 2 }));
      if (n === 0) break;
      expect(n).toBeLessThanOrEqual(2); // bounded per run
      if (++loops > 10) throw new Error("did not drain");
    }
    expect(await count(shopA)).toBe(0);
  });

  it("selectInstalledShops enumerates both installed shops (reused enumerator)", async () => {
    const ids = await db.withShopExec(shopA, (e) => selectInstalledShops(e));
    expect(ids).toContain(shopA);
    expect(ids).toContain(shopB);
  });

  it("runSignalRetention purges one batch per installed shop in the tick path", async () => {
    await db.withShopExec(shopA, (e) => recordSignal(e, shopA, vA, G(1), "view", daysBefore(RETENTION_DAYS + 10)));
    await db.withShopExec(shopB, (e) => recordSignal(e, shopB, vB, G(1), "view", daysBefore(RETENTION_DAYS + 10)));
    // rootExec enumerates installed shops; withShopExec runs the per-shop purge.
    const deleted = await runSignalRetention(db.rootExec, db.withShopExec, { now: NOW });
    expect(deleted).toBe(2); // one expired row per shop
    expect(await count(shopA)).toBe(0);
    expect(await count(shopB)).toBe(0);
  });
});
