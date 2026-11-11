import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion, getActiveVersion, rollbackToVersion } from "~/lib/index/engine";
import { rebuildVocabulary } from "~/lib/search/vocabulary";
import { applyProductUpsert, applyProductDeletion } from "~/lib/sync/orchestrator";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { predictiveWithExec } from "~/lib/search/predictive";
import { catalogSuggestionsWithExec } from "~/lib/search/suggest";
import { recommendContent } from "~/lib/recommend/content";
import type { NormalizedProduct } from "~/lib/catalog/bulk-parse";

/*
 * Phase 14c W2(d) — READ EQUIVALENCE battery. At a state reached by incremental
 * (delta-maintained) writes, every read — search (filtered + unfiltered browse),
 * predictive, suggestions, NL parsing, facets, recommendations — must return
 * EXACTLY what it returns after a fresh FULL REBUILD of the same state. Run
 * across states: load, incremental updates, delete, rollback.
 */
let seed = 55;
const rnd = (m: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % m; };
const VEND = ["Nike", "Adidas", "Puma"]; const TYP = ["Shoe", "Boot"]; const TAG = ["red", "Sport", "sale"]; const MAT = ["Leather", "Canvas"];
const TIT = ["Running Shoe", "Trail Boot", "Red Sandal", "Sport Shoe"];
function prod(i: number): NormalizedProduct {
  const gid = `gid://shopify/Product/${i}`;
  return {
    product: { shopifyProductGid: gid, title: TIT[rnd(TIT.length)] + " " + i, handle: `h${i}`, vendor: VEND[rnd(VEND.length)],
      productType: TYP[rnd(TYP.length)], status: rnd(9) === 0 ? "DRAFT" : "ACTIVE", tags: [TAG[rnd(TAG.length)], TAG[rnd(TAG.length)]],
      onlineStoreUrl: rnd(7) !== 0 ? `https://x.test/${i}` : null, featuredImageUrl: "https://img/x.jpg", featuredImageAlt: "x",
      metafields: { "custom.material": MAT[rnd(MAT.length)] }, combinedRole: null, combinedParentGid: null },
    variants: [{ shopifyVariantGid: `${gid}/v1`, sku: `S${i}`, price: String(10 + rnd(90)), availableForSale: rnd(4) !== 0, position: 1 }],
    collectionGids: [], variantsComplete: true, collectionsComplete: true,
  };
}

// Drop volatile timing fields (tookMs) so only substantive output is compared.
function noTiming<T>(r: T): T { const { tookMs, ...rest } = r as any; return rest; }

async function captureReads(e: Exec, shop: string, ver: string) {
  const search = async (q: string, nl: boolean, filters?: any) =>
    noTiming(await storefrontSearchWithExec(e, shop, { q, nl, limit: 24, offset: 0, ...(filters ?? {}) }));
  return {
    browse: await search("", false),                         // unfiltered → precompute facets
    searchShoe: await search("shoe", false),                 // query → live facets
    searchFiltered: await search("shoe", false, { vendor: ["Nike"] }),
    nl: await search("red nike shoe under 50", true),        // NL parse-context
    predRun: noTiming(await predictiveWithExec(e, shop, { q: "run", limit: 10 })),
    predRed: noTiming(await predictiveWithExec(e, shop, { q: "red", limit: 10 })),
    suggRun: await catalogSuggestionsWithExec(e, shop, "run"),
    suggS: await catalogSuggestionsWithExec(e, shop, "s"),
    rec: await recommendContent(e, shop, ver, [{ kind: "gid", value: "gid://shopify/Product/1" }],
      { kind: "related", limit: 24, includeOutOfStock: false, diversifyPerVendor: 0, hideIds: [] }),
  };
}

// delta-state reads == reads after a fresh full rebuild of the same state
async function assertReadsMatchRebuild(db: TestDb, shop: string, ver: string) {
  const deltaReads = await db.withShopExec(shop, (e) => captureReads(e, shop, ver));
  await db.withShopExec(shop, (e) => rebuildVocabulary(e, shop, ver));
  const freshReads = await db.withShopExec(shop, (e) => captureReads(e, shop, ver));
  expect(deltaReads).toEqual(freshReads);
}

describe("Phase 14c W2d — reads are identical to a fresh rebuild across states", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); seed = 55; shop = await db.resolveShop("p14c-read.myshopify.com"); });

  it("state: load → incremental updates → delete → rollback, reads match rebuild at each", async () => {
    const runner = db.withShopExec.bind(db);
    for (let i = 1; i <= 25; i++) await applyProductUpsert(runner, shop, prod(i));
    const n0 = 25;
    const v1 = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n0));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v1.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v1.id, n0));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v1.id));

    // STATE 1: fresh load.
    await assertReadsMatchRebuild(db, shop, v1.id);

    // STATE 2: 60 incremental (delta) updates incl price/tag/vendor/publish changes.
    for (let op = 0; op < 60; op++) await applyProductUpsert(runner, shop, prod(1 + rnd(25)));
    await assertReadsMatchRebuild(db, shop, v1.id);

    // STATE 3: delete a few.
    for (const i of [3, 7, 11]) await applyProductDeletion(runner, shop, `gid://shopify/Product/${i}`);
    await assertReadsMatchRebuild(db, shop, v1.id);

    // STATE 4: a NEW version built + activated, more updates, then ROLLBACK to v1.
    const n1 = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
    const v2 = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n1));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v2.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v2.id, n1));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v2.id));
    for (let op = 0; op < 20; op++) await applyProductUpsert(runner, shop, prod(1 + rnd(25)));
    await db.withShopExec(shop, (e) => rollbackToVersion(e, shop, v1.id));
    const active = await db.withShopExec(shop, async (e) => (await getActiveVersion(e, shop))!.id);
    expect(active).toBe(v1.id);
    // after rollback, more delta updates on the restored version, then compare
    for (let op = 0; op < 15; op++) await applyProductUpsert(runner, shop, prod(1 + rnd(25)));
    await assertReadsMatchRebuild(db, shop, v1.id);
  });
});
