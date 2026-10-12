import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { createBundle, type BundleInput, type SlotInput } from "~/lib/bundles/model";
import { listVisibleBundles } from "~/lib/bundles/engine";

/*
 * Phase 10.1 M1 (lookup by resolved identity) + M3 (bounded/batched query cost).
 * Realistic handles ("red-shoe"), not numeric. Migration 0012 applied.
 */
const PG = (n: number) => `gid://shopify/Product/${n}`;
const VG = (n: number) => `gid://shopify/ProductVariant/${n}`;

interface PSeed { gid: string; handle: string; title: string; published?: boolean; vgid: string; available?: boolean }
async function seed(db: TestDb, shop: string, p: PSeed) {
  await db.withShopExec(shop, async (e) => {
    const published = p.published !== false;
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: p.gid, title: p.title, handle: p.handle, vendor: "Acme", productType: "T", tags: [],
      status: "ACTIVE", onlineStoreUrl: published ? `https://shop.example/products/${p.handle}` : null,
      featuredImageUrl: `https://cdn.shopify.com/s/files/1/${p.handle}.jpg`, metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: p.vgid, sku: "SKU-" + p.handle, price: "10.00", availableForSale: p.available ?? true });
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
const slot = (kind: "gid" | "handle", value: string): SlotInput => ({ productRefKind: kind, productRefValue: value, variantMode: "customer_picks", quantity: 1 });
const bundle = (name: string, slots: SlotInput[], ov: Partial<BundleInput> = {}): BundleInput => ({ name, bundleType: "fixed", status: "active", slots, ...ov });

/** Count every rows()/run() call made through the wrapped exec. */
function counting(e: Exec): { exec: Exec; count: () => number } {
  let n = 0;
  return {
    count: () => n,
    exec: {
      rows: (<T>(sql: string, params?: unknown[]) => { n++; return e.rows<T>(sql, params as unknown[]); }) as Exec["rows"],
      run: ((sql: string, params?: unknown[]) => { n++; return e.run(sql, params as unknown[]); }) as Exec["run"],
    },
  };
}

const NOW = new Date("2026-05-01T12:00:00Z");

describe("Phase 10.1 M1 — bundle lookup by resolved product identity", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p10l.myshopify.com");
    await seed(db, shop, { gid: PG(1), handle: "red-shoe", title: "Red Shoe", vgid: VG(11) });
    await seed(db, shop, { gid: PG(2), handle: "blue-hat", title: "Blue Hat", vgid: VG(21) });
    await seed(db, shop, { gid: PG(3), handle: "green-sock", title: "Green Sock", vgid: VG(31) });
    await build(db, shop);
  });
  const list = (productRef: string | null) => db.withShopExec(shop, (e) => listVisibleBundles(e, shop, { productRef, now: NOW }));

  it("gid-slot bundle is found by BOTH a handle lookup and a gid lookup", async () => {
    await db.withShopExec(shop, (e) => createBundle(e, shop, bundle("GidBundle", [slot("gid", PG(1)), slot("gid", PG(2))])));
    expect((await list("red-shoe")).map((b) => b.name)).toEqual(["GidBundle"]);   // handle lookup
    expect((await list(PG(1))).map((b) => b.name)).toEqual(["GidBundle"]);        // gid lookup
  });

  it("handle-slot bundle is found by BOTH a gid lookup and a handle lookup", async () => {
    await db.withShopExec(shop, (e) => createBundle(e, shop, bundle("HandleBundle", [slot("handle", "red-shoe"), slot("handle", "blue-hat")])));
    expect((await list(PG(1))).map((b) => b.name)).toEqual(["HandleBundle"]);     // gid lookup
    expect((await list("red-shoe")).map((b) => b.name)).toEqual(["HandleBundle"]); // handle lookup
  });

  it("mixed-kind bundle matches on either slot's product", async () => {
    await db.withShopExec(shop, (e) => createBundle(e, shop, bundle("Mixed", [slot("gid", PG(1)), slot("handle", "blue-hat")])));
    expect((await list("red-shoe")).map((b) => b.name)).toEqual(["Mixed"]); // via gid slot (resolved by handle lookup)
    expect((await list(PG(2))).map((b) => b.name)).toEqual(["Mixed"]);      // via handle slot (resolved by gid lookup)
  });

  it("handle case differences still match (slot 'Red-Shoe' vs lookup 'red-shoe' and reverse)", async () => {
    // normalizeBundleInput lower-cases slot handles, so a slot entered "Red-Shoe"
    // is stored "red-shoe"; a lookup for "Red-Shoe" is lowered when matched.
    await db.withShopExec(shop, (e) => createBundle(e, shop, bundle("CaseBundle", [slot("handle", "Red-Shoe"), slot("handle", "blue-hat")])));
    expect((await list("red-shoe")).map((b) => b.name)).toEqual(["CaseBundle"]);
    expect((await list("RED-SHOE")).map((b) => b.name)).toEqual(["CaseBundle"]);
  });

  it("unknown / draft / other-shop product → [] (never all bundles)", async () => {
    await db.withShopExec(shop, (e) => createBundle(e, shop, bundle("B", [slot("gid", PG(1)), slot("gid", PG(2))])));
    expect(await list("no-such-handle")).toEqual([]);
    expect(await list(PG(9999))).toEqual([]);
    // a draft (unpublished) product does not resolve → []
    await seed(db, shop, { gid: PG(4), handle: "hidden-prod", title: "Hidden", published: false, vgid: VG(41) });
    await build(db, shop);
    expect(await list("hidden-prod")).toEqual([]);
  });

  it("a bundle not containing the looked-up product is not returned", async () => {
    await db.withShopExec(shop, (e) => createBundle(e, shop, bundle("ShoeHat", [slot("gid", PG(1)), slot("gid", PG(2))])));
    // green-sock is a real visible product but in no bundle
    expect(await list("green-sock")).toEqual([]);
  });

  it("a hidden (unavailable) bundle stays hidden even when matched", async () => {
    // Bundle references blue-hat which we make out of stock → bundle hidden.
    await db.withShopExec(shop, (e) => createBundle(e, shop, bundle("WillHide", [slot("gid", PG(1)), slot("gid", PG(2))])));
    await seed(db, shop, { gid: PG(2), handle: "blue-hat", title: "Blue Hat", vgid: VG(21), available: false });
    await build(db, shop);
    expect(await list("red-shoe")).toEqual([]); // matched but unavailable → hidden
  });
});

describe("Phase 10.1 M3 — bounded + batched query cost", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p10q.myshopify.com");
    await seed(db, shop, { gid: PG(1), handle: "prod-a", title: "A", vgid: VG(11) });
    await seed(db, shop, { gid: PG(2), handle: "prod-b", title: "B", vgid: VG(21) });
    await seed(db, shop, { gid: PG(3), handle: "prod-unused", title: "Unused", vgid: VG(31) });
    await build(db, shop);
    // 40 active bundles, each referencing prod-a + prod-b.
    for (let i = 0; i < 40; i++) {
      await db.withShopExec(shop, (e) => createBundle(e, shop, bundle("B" + i, [slot("gid", PG(1)), slot("gid", PG(2))])));
    }
  });

  it("no-match lookup costs <= 3 queries regardless of bundle count", async () => {
    const r = await db.withShopExec(shop, async (e) => {
      const c = counting(e);
      const out = await listVisibleBundles(c.exec, shop, { productRef: "prod-unused", now: NOW });
      return { out, q: c.count() };
    });
    expect(r.out).toEqual([]);
    expect(r.q).toBe(3); // exact: active version + resolve ref + candidate-ids
  });

  it("matching lookup costs <= 7 queries independent of bundle count, and returns all matches", async () => {
    const r = await db.withShopExec(shop, async (e) => {
      const c = counting(e);
      const out = await listVisibleBundles(c.exec, shop, { productRef: "prod-a", limit: 50, now: NOW });
      return { out, q: c.count() };
    });
    expect(r.out.length).toBe(40);       // all 40 bundles contain prod-a
    expect(r.q).toBe(7); // exact: +bundles +slots +docs +variants; constant, not ~242
  });

  it("the candidate set is hard-capped (<= 50) per request", async () => {
    const out = await db.withShopExec(shop, (e) => listVisibleBundles(e, shop, { productRef: "prod-a", limit: 50, now: NOW }));
    expect(out.length).toBeLessThanOrEqual(50);
  });
});
