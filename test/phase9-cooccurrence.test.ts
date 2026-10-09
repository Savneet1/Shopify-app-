import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import {
  rebuildCooccurrence, frequentlyBoughtTogether, SyntheticBasketSource,
} from "~/lib/recommend/cooccurrence";

/*
 * Phase 9.3 — FBT co-occurrence builder + query. Driven by a SYNTHETIC basket
 * source ONLY (no Shopify orders are read anywhere). node-postgres; migration
 * 0011 must be applied to the test DB.
 */
const G = (n: number) => `gid://shopify/Product/${n}`;
const handleOf = (gid: string) => gid.split("/").pop()!;

async function seed(db: TestDb, shop: string, gid: string, title: string, available = true) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: gid, title, handle: handleOf(gid), vendor: "V", productType: "T", tags: [],
      status: "ACTIVE", onlineStoreUrl: `https://shop.example/products/${handleOf(gid)}`,
      featuredImageUrl: `https://cdn.shopify.com/${handleOf(gid)}.jpg`, metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: gid + "/v", sku: "S-" + handleOf(gid), price: "10", availableForSale: available });
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

const BASKETS = [
  [G(1), G(2), G(3)],
  [G(1), G(2)],
  [G(1), G(2)],
  [G(1), G(4)],
  [G(3)], // singleton: no pairs
];

describe("Phase 9.3 — FBT co-occurrence", () => {
  let db: TestDb;
  let shop: string;
  let version: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p9f.myshopify.com");
    for (let i = 1; i <= 5; i++) await seed(db, shop, G(i), "P" + i);
    version = await build(db, shop);
  });

  const rebuild = (baskets: string[][], maxBasketSize?: number) =>
    db.withShopExec(shop, (e) => rebuildCooccurrence(e, shop, version, new SyntheticBasketSource(baskets), { maxBasketSize, sourceLabel: "synthetic" }));
  const fbt = (seed: unknown, opts: Partial<Parameters<typeof frequentlyBoughtTogether>[4]> = {}) =>
    db.withShopExec(shop, (e) => frequentlyBoughtTogether(e, shop, version, seed, {
      limit: 24, minSupport: 1, minConfidence: 0, ranking: "confidence", includeOutOfStock: false, hideIds: [], ...opts,
    }));

  it("builds correct support + pair counts and basket N", async () => {
    const res = await rebuild(BASKETS);
    expect(res.basketCount).toBe(5);
    expect(res.itemCount).toBe(4); // P1..P4 (P5 never purchased)
    expect(res.pairCount).toBe(4); // (1,2),(1,3),(2,3),(1,4)
    const n = await db.withShopExec(shop, (e) => e.rows<{ basket_count: number }>("SELECT basket_count::int FROM product_cooccurrence_build WHERE shop_id=$1::uuid", [shop]));
    expect(n[0].basket_count).toBe(5);
  });

  it("ranks FBT by confidence and respects minSupport/minConfidence", async () => {
    await rebuild(BASKETS);
    // minSupport=2 → only P2 (pair_count 3) qualifies for seed P1
    const strict = await fbt(G(1), { minSupport: 2 });
    expect(strict.map((p) => p.gid)).toEqual([G(2)]);
    // minSupport=1 → P2(0.75) > {P3,P4 both 0.25, tie-break title P3<P4}
    const loose = await fbt(G(1), { minSupport: 1 });
    expect(loose.map((p) => p.gid)).toEqual([G(2), G(3), G(4)]);
    // confidence(P1→P2) = 3/4
    expect(loose[0].score).toBeCloseTo(0.75, 6);
    // minConfidence filter drops the 0.25 pairs
    const conf = await fbt(G(1), { minSupport: 1, minConfidence: 0.5 });
    expect(conf.map((p) => p.gid)).toEqual([G(2)]);
  });

  it("pairs are symmetric (seed order irrelevant)", async () => {
    await rebuild(BASKETS);
    const forP2 = await fbt(G(2), { minSupport: 1 });
    expect(forP2.find((p) => p.gid === G(1))).toBeTruthy();
    // confidence(P2→P1) = 3/support(P2)=3/3 = 1.0
    const p1 = forP2.find((p) => p.gid === G(1))!;
    expect(p1.score).toBeCloseTo(1.0, 6);
  });

  it("lift ranking uses N and both supports", async () => {
    await rebuild(BASKETS);
    const out = await fbt(G(1), { minSupport: 2, ranking: "lift" });
    // lift(P1→P2) = pair(3)·N(5) / (sup(P1)=4 · sup(P2)=3) = 15/12 = 1.25
    expect(out[0].gid).toBe(G(2));
    expect(out[0].score).toBeCloseTo(1.25, 6);
  });

  it("rebuild is idempotent (same source → same table)", async () => {
    await rebuild(BASKETS);
    const snap = () => db.withShopExec(shop, (e) => e.rows("SELECT product_a, product_b, pair_count FROM product_cooccurrence WHERE shop_id=$1::uuid ORDER BY product_a, product_b", [shop]));
    const a = await snap();
    await rebuild(BASKETS);
    const b = await snap();
    expect(b).toEqual(a);
  });

  it("empty data / unknown seed → [] (degrade handled by caller)", async () => {
    // no rebuild at all
    expect(await fbt(G(1))).toEqual([]);
    await rebuild(BASKETS);
    expect(await fbt(G(9999))).toEqual([]);     // unknown seed
    expect(await fbt("junk ref")).toEqual([]);  // invalid ref
    expect(await fbt(G(5))).toEqual([]);        // P5 never purchased → no pairs
  });

  it("ignores oversized baskets (cost + noise cap)", async () => {
    // maxBasketSize=2: the size-3 basket is ignored; only [G1,G2] counts.
    const res = await rebuild([[G(1), G(2), G(3)], [G(1), G(2)]], 2);
    expect(res.basketCount).toBe(1);
    expect(res.pairCount).toBe(1);
    const out = await fbt(G(1), { minSupport: 1 });
    expect(out.map((p) => p.gid)).toEqual([G(2)]); // P3 never paired (its basket dropped)
  });

  it("only visible products are returned (OOS excluded by default; hide respected)", async () => {
    await seed(db, shop, G(6), "P6", false); // OOS
    version = await build(db, shop);
    await rebuild([[G(1), G(6)], [G(1), G(6)], [G(1), G(2)], [G(1), G(2)]]);
    const def = await fbt(G(1), { minSupport: 1 });
    expect(def.find((p) => p.gid === G(6))).toBeUndefined();     // OOS excluded
    const incl = await fbt(G(1), { minSupport: 1, includeOutOfStock: true });
    expect(incl.find((p) => p.gid === G(6))).toBeTruthy();
    const p2 = def.find((p) => p.gid === G(2))!;
    const hidden = await fbt(G(1), { minSupport: 1, hideIds: [p2.id] });
    expect(hidden.find((p) => p.id === p2.id)).toBeUndefined();
  });
});
