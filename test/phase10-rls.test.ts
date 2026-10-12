import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { createBundle, getBundle, listBundles, type BundleInput } from "~/lib/bundles/model";

/*
 * Phase 10 — RLS + cross-shop isolation on every new bundle table.
 * (bundle_signal_daily cross-shop isolation is also covered in phase10-signals.)
 */
const PG = (n: number) => `gid://shopify/Product/${n}`;
const input = (): BundleInput => ({
  name: "Kit", bundleType: "fixed", status: "active",
  slots: [
    { productRefKind: "gid", productRefValue: PG(1), variantMode: "customer_picks", quantity: 1 },
    { productRefKind: "gid", productRefValue: PG(2), variantMode: "customer_picks", quantity: 1 },
  ],
});

describe("Phase 10 — RLS + cross-shop isolation", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p10rA.myshopify.com");
    shopB = await db.resolveShop("p10rB.myshopify.com");
  });

  it("RLS is enabled on every Phase 10 tenant table", async () => {
    const { rows } = await db.runtimePool.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
       AND tablename IN ('bundle','bundle_slot','bundle_signal_daily')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.rowsecurity).toBe(true);
  });

  it("a bundle (and its slots) created by shop A are invisible to shop B", async () => {
    const id = await db.withShopExec(shopA, (e) => createBundle(e, shopA, input()));
    // shop A sees it
    expect((await db.withShopExec(shopA, (e) => getBundle(e, shopA, id)))).not.toBeNull();
    expect((await db.withShopExec(shopA, (e) => listBundles(e, shopA))).length).toBe(1);
    // shop B sees nothing — not the bundle, not its slots
    expect(await db.withShopExec(shopB, (e) => getBundle(e, shopB, id))).toBeNull();
    expect((await db.withShopExec(shopB, (e) => listBundles(e, shopB))).length).toBe(0);
    const bSlots = await db.withShopExec(shopB, (e) => e.rows("SELECT * FROM bundle_slot"));
    expect(bSlots.length).toBe(0);
    const bBundles = await db.withShopExec(shopB, (e) => e.rows("SELECT * FROM bundle"));
    expect(bBundles.length).toBe(0);
  });

  it("shop B cannot mutate shop A's bundle (update/delete affect 0 rows)", async () => {
    const id = await db.withShopExec(shopA, (e) => createBundle(e, shopA, input()));
    const delN = await db.withShopExec(shopB, (e) => e.run("DELETE FROM bundle WHERE id=$1::uuid", [id]));
    expect(delN).toBe(0);
    // still present for A
    expect(await db.withShopExec(shopA, (e) => getBundle(e, shopA, id))).not.toBeNull();
  });
});
