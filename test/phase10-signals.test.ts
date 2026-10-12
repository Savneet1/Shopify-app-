import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { createBundle, type BundleInput } from "~/lib/bundles/model";
import {
  recordBundleSignal, bundleSignalSummary, purgeOldBundleSignals, BUNDLE_RETENTION_DAYS,
} from "~/lib/bundles/signals";
import { runSignalRetention } from "~/lib/jobs/maintenance";

/*
 * Phase 10.6 — bundle signals beacon + retention. Migration 0012 applied.
 */
const PG = (n: number) => `gid://shopify/Product/${n}`;
const VG = (n: number) => `gid://shopify/ProductVariant/${n}`;
const handleOf = (g: string) => g.split("/").pop()!;

async function seedProduct(db: TestDb, shop: string, gid: string) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: gid, title: "P" + handleOf(gid), handle: handleOf(gid), vendor: "V", productType: "T",
      tags: [], status: "ACTIVE", onlineStoreUrl: `https://shop.example/products/${handleOf(gid)}`,
      featuredImageUrl: `https://cdn.shopify.com/${handleOf(gid)}.jpg`, metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: gid + "/v", sku: "S", price: "10", availableForSale: true });
  });
}
async function build(db: TestDb, shop: string) {
  const n = await db.withShopExec(shop, async (e) =>
    (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
}
const bundleInput = (): BundleInput => ({
  name: "Kit", bundleType: "fixed", status: "active",
  slots: [
    { productRefKind: "gid", productRefValue: PG(1), variantMode: "customer_picks", quantity: 1 },
    { productRefKind: "gid", productRefValue: PG(2), variantMode: "customer_picks", quantity: 1 },
  ],
});

const NOW = new Date("2026-07-01T12:00:00Z");
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86400_000);

describe("Phase 10.6 — bundle signals", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;
  let bundleA: string;
  let bundleB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p10sA.myshopify.com");
    await seedProduct(db, shopA, PG(1)); await seedProduct(db, shopA, PG(2)); await build(db, shopA);
    bundleA = await db.withShopExec(shopA, (e) => createBundle(e, shopA, bundleInput()));
    shopB = await db.resolveShop("p10sB.myshopify.com");
    await seedProduct(db, shopB, PG(1)); await seedProduct(db, shopB, PG(2)); await build(db, shopB);
    bundleB = await db.withShopExec(shopB, (e) => createBundle(e, shopB, bundleInput()));
  });
  const rec = (shop: string, id: unknown, type: unknown, now = NOW) =>
    db.withShopExec(shop, (e) => recordBundleSignal(e, shop, id, type, now));
  const count = (shop: string) =>
    db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM bundle_signal_daily WHERE shop_id=$1::uuid", [shop]))[0].n);

  it("records view/add_to_cart aggregate counters; table has no PII columns", async () => {
    expect(await rec(shopA, bundleA, "view")).toBe(true);
    expect(await rec(shopA, bundleA, "add_to_cart")).toBe(true);
    const sum = await db.withShopExec(shopA, (e) => bundleSignalSummary(e, shopA, { now: NOW }));
    expect(sum).toEqual([{ bundle_id: bundleA, views: 1, add_to_cart_clicks: 1 }]);
    const cols = await db.withShopExec(shopA, (e) => e.rows<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='bundle_signal_daily'"));
    expect(cols.map((c) => c.column_name).sort()).toEqual(["add_to_cart_clicks", "bundle_id", "day", "shop_id", "updated_at", "views"]);
  });

  it("hostile / junk input is a no-op (never throws, never writes)", async () => {
    for (const [id, type] of [
      ["not-a-uuid", "view"],
      ["'; DROP TABLE bundle_signal_daily; --", "view"],
      ["x".repeat(500), "add_to_cart"],
      [bundleA, "purchase"],            // bad type
      ["00000000-0000-0000-0000-000000000000", "view"], // uuid but no such bundle
      [bundleB, "view"],                // other shop's bundle (from shop A context)
      [null, "view"],
      [bundleA, null],
    ] as [unknown, unknown][]) {
      expect(await rec(shopA, id, type)).toBe(false);
    }
    expect(await count(shopA)).toBe(0);
  });

  it("other-shop bundle id cannot be recorded cross-tenant", async () => {
    // From shop A, recording shop B's real bundle id must be a no-op.
    expect(await rec(shopA, bundleB, "view")).toBe(false);
    // Each shop records only its own.
    expect(await rec(shopA, bundleA, "view")).toBe(true);
    expect(await rec(shopB, bundleB, "view")).toBe(true);
    expect(await count(shopA)).toBe(1);
    expect(await count(shopB)).toBe(1);
  });

  it("retention purge deletes old rows, keeps new, other shop untouched, idempotent, batched", async () => {
    await rec(shopA, bundleA, "view", daysBefore(BUNDLE_RETENTION_DAYS + 10));
    await rec(shopA, bundleA, "view", daysBefore(5));
    await rec(shopB, bundleB, "view", daysBefore(BUNDLE_RETENTION_DAYS + 10));
    const d1 = await db.withShopExec(shopA, (e) => purgeOldBundleSignals(e, shopA, { now: NOW }));
    expect(d1).toBe(1);
    expect(await count(shopA)).toBe(1);
    expect(await count(shopB)).toBe(1); // other shop untouched
    const d2 = await db.withShopExec(shopA, (e) => purgeOldBundleSignals(e, shopA, { now: NOW }));
    expect(d2).toBe(0); // idempotent

    // batching: 4 old distinct days, batchSize 2 → drains over runs.
    for (let i = 1; i <= 4; i++) await rec(shopA, bundleA, "view", daysBefore(BUNDLE_RETENTION_DAYS + i));
    let loops = 0;
    for (;;) {
      const n = await db.withShopExec(shopA, (e) => purgeOldBundleSignals(e, shopA, { now: NOW, batchSize: 2 }));
      if (n === 0) break;
      expect(n).toBeLessThanOrEqual(2);
      if (++loops > 10) throw new Error("did not drain");
    }
    // only the in-retention row remains
    expect(await count(shopA)).toBe(1);
  });

  it("maintenance tick retention pass purges bundle signals for all installed shops", async () => {
    await rec(shopA, bundleA, "view", daysBefore(BUNDLE_RETENTION_DAYS + 10));
    await rec(shopB, bundleB, "view", daysBefore(BUNDLE_RETENTION_DAYS + 10));
    const deleted = await runSignalRetention(db.rootExec, db.withShopExec, { now: NOW });
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await count(shopA)).toBe(0);
    expect(await count(shopB)).toBe(0);
  });
});
