import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { rebuildVocabulary } from "~/lib/search/vocabulary";
import { reconcileIndexStructures } from "~/lib/index/indexdelta";
import { precomputedFacets } from "~/lib/search/facetcache";
import { applyProductUpsert } from "~/lib/sync/orchestrator";
import type { NormalizedProduct } from "~/lib/catalog/bulk-parse";

function prod(i: number, vendor: string, tag: string, price: string, title: string): NormalizedProduct {
  const gid = `gid://shopify/Product/${i}`;
  return {
    product: { shopifyProductGid: gid, title, handle: `h${i}`, vendor, productType: "Shoe", status: "ACTIVE", tags: [tag],
      onlineStoreUrl: `https://x.test/${i}`, featuredImageUrl: "https://img/x.jpg", featuredImageAlt: "x", metafields: {},
      combinedRole: null, combinedParentGid: null },
    variants: [{ shopifyVariantGid: `${gid}/v1`, sku: `S${i}`, price, availableForSale: true, position: 1 }],
    collectionGids: [], variantsComplete: true, collectionsComplete: true,
  };
}

async function dump(e: Exec, shop: string, ver: string) {
  return {
    fv: await e.rows(`SELECT kind, value, doc_count FROM search_facet_value WHERE shop_id=$1::uuid AND index_version_id=$2::uuid ORDER BY kind,value`, [shop, ver]),
    st: await e.rows(`SELECT type, text, doc_count FROM search_suggest_term WHERE shop_id=$1::uuid AND index_version_id=$2::uuid ORDER BY type,text`, [shop, ver]),
    vocab: await e.rows(`SELECT term, doc_freq FROM search_vocabulary WHERE shop_id=$1::uuid AND index_version_id=$2::uuid ORDER BY term`, [shop, ver]),
  };
}

describe("Phase 14c W2b/W2c — concurrency and drift reconcile", () => {
  let db: TestDb; let shop: string; let ver: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  async function build(n: number, mk: (i: number) => NormalizedProduct) {
    const runner = db.withShopExec.bind(db);
    for (let i = 1; i <= n; i++) await applyProductUpsert(runner, shop, mk(i));
    const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
    return v.id;
  }

  beforeEach(async () => { await db.resetDb(); shop = await db.resolveShop("p14c-rc.myshopify.com"); });

  it("W2c: reconcile DETECTS a deliberately corrupted row, repairs it, and reports drift", async () => {
    ver = await build(10, (i) => prod(i, "Nike", "sport", "20", `Title ${i}`));
    // Corrupt: bump a facet_value count to a wrong value.
    await db.withShopExec(shop, (e) => e.run(
      `UPDATE search_facet_value SET doc_count = doc_count + 7 WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND kind='vendor' AND value='Nike'`, [shop, ver]));
    const res = await db.withShopExec(shop, (e) => reconcileIndexStructures(e, shop, ver));
    expect(res.drifted).toBe(true);
    expect(res.structures).toContain("fv");
    // repaired: now equal to a fresh rebuild
    const afterReconcile = await db.withShopExec(shop, (e) => dump(e, shop, ver));
    await db.withShopExec(shop, (e) => rebuildVocabulary(e, shop, ver));
    const fresh = await db.withShopExec(shop, (e) => dump(e, shop, ver));
    expect(afterReconcile).toEqual(fresh);
  });

  it("W2c: reconcile reports NO drift on a correctly delta-maintained version", async () => {
    ver = await build(10, (i) => prod(i, "Nike", "sport", "20", `Title ${i}`));
    // a few incremental updates (delta-maintained)
    const runner = db.withShopExec.bind(db);
    for (let i = 1; i <= 5; i++) await applyProductUpsert(runner, shop, prod(i, "Adidas", "run", "30", `New ${i}`));
    const res = await db.withShopExec(shop, (e) => reconcileIndexStructures(e, shop, ver));
    expect(res.drifted).toBe(false);
    expect(res.structures).toEqual([]);
  });

  it("price-range dirty fallback: raising the min-price product yields the correct live min (not a stale stored value)", async () => {
    // product 1 has the unique minimum price (5); others 50+.
    ver = await build(8, (i) => prod(i, "Nike", "sport", i === 1 ? "5" : String(50 + i), `Title ${i}`));
    let f = await db.withShopExec(shop, (e) => precomputedFacets(e, shop, ver));
    expect(f.priceRange?.min).toBe("5.00");
    // Raise product 1's price to 999 → the old minimum (5) is dropped → price_dirty.
    await applyProductUpsert(db.withShopExec.bind(db), shop, prod(1, "Nike", "sport", "999", "Title 1"));
    const dirty = await db.withShopExec(shop, async (e) => (await e.rows<{ d: boolean }>(
      `SELECT price_dirty d FROM search_facet_summary WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`, [shop, ver]))[0].d);
    expect(dirty).toBe(true); // raising the extreme set the flag
    // The reader must return the NEW live minimum (52 from product 2), via fallback.
    f = await db.withShopExec(shop, (e) => precomputedFacets(e, shop, ver));
    expect(f.priceRange?.min).toBe("52.00");
    // and it equals a fresh rebuild's price range
    await db.withShopExec(shop, (e) => rebuildVocabulary(e, shop, ver));
    const fresh = await db.withShopExec(shop, (e) => precomputedFacets(e, shop, ver));
    expect(f.priceRange).toEqual(fresh.priceRange);
  });

  it("W2b: 8 parallel updates over overlapping vendors/tags end equal to a full rebuild, no deadlock", async () => {
    // Shared values so the 8 writers contend on the SAME structure rows.
    ver = await build(40, (i) => prod(i, i % 2 ? "Nike" : "Adidas", i % 2 ? "sport" : "run", "20", `T ${i % 5}`));
    const runner = db.withShopExec.bind(db);
    // 8 concurrent writers, each updating a disjoint set of products but to the
    // SAME small pool of vendor/tag/title values (overlap → row contention).
    const vendors = ["Nike", "Adidas"]; const tags = ["sport", "run"]; const titles = ["T 0", "T 1", "T 2"];
    const writers = Array.from({ length: 8 }, (_, w) => (async () => {
      for (let k = 0; k < 6; k++) {
        const id = 1 + w * 5 + (k % 5); // products 1..40, disjoint-ish per writer
        await applyProductUpsert(runner, shop, prod(id, vendors[(w + k) % 2], tags[(w + k) % 2], String(10 + ((w + k) % 20)), titles[(w + k) % 3]));
      }
    })());
    await expect(Promise.all(writers)).resolves.toBeDefined(); // no deadlock/throw

    // Final delta state must equal a fresh full rebuild.
    const deltaDump = await db.withShopExec(shop, (e) => dump(e, shop, ver));
    await db.withShopExec(shop, (e) => rebuildVocabulary(e, shop, ver));
    const fresh = await db.withShopExec(shop, (e) => dump(e, shop, ver));
    expect(deltaDump).toEqual(fresh);
  });
});
