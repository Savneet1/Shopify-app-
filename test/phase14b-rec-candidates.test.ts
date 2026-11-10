import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import { upsertProduct, upsertVariant, upsertCollection, replaceProductCollectionsByGids } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion, getActiveVersion } from "~/lib/index/engine";
import { recommendContent, WEIGHTS, type ContentKind } from "~/lib/recommend/content";

/*
 * Phase 14b P5 — the index-union candidate generation produces results IDENTICAL
 * to the original "score every visible doc" query. The reference below is the
 * pre-P5 query (candidate = all visible non-seed docs) with the SAME scoring and
 * qualify filter; recommendContent is the new index-driven version. We diff them
 * item-by-item (id order + scores) on randomised catalogs, including the worst
 * case where the seed shares a very large vendor/type.
 */

// Reference = original scan-all candidate query (single gid seed, no diversify).
async function referenceRec(e: Exec, shop: string, ver: string, seedGid: string, kind: ContentKind): Promise<{ id: string; score: number }[]> {
  const w = WEIGHTS[kind];
  const p = [shop, ver, seedGid, w.collectionCap, w.tagCap, w.wCollection, w.wType, w.wVendor, w.wTag, w.wPrice, w.wTrgm, w.wTrgm * 0.3, 24];
  const rows = await e.rows<{ product_id: string; score: number }>(
    `WITH seeds AS (
       SELECT product_id AS seed_id, title AS seed_title, vendor AS seed_vendor, product_type AS seed_type,
              tags AS seed_tags, price_min AS seed_price,
              ARRAY(SELECT jsonb_array_elements_text(doc->'collections')) AS seed_cols
       FROM product_search_doc
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'
         AND shopify_product_gid = $3
     ),
     cand AS (
       SELECT d.product_id, d.shopify_product_gid AS gid, d.doc, d.title, d.vendor, d.product_type, d.tags, d.price_min,
              ARRAY(SELECT jsonb_array_elements_text(d.doc->'collections')) AS cols
       FROM product_search_doc d
       WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid AND d.published=true AND d.status='ACTIVE'
         AND d.available = true AND d.product_id NOT IN (SELECT seed_id FROM seeds)
     ),
     scored AS (
       SELECT c.product_id, c.title,
         (sc.s_col + sc.s_type + sc.s_vendor + sc.s_tag + sc.s_price + sc.s_trgm) AS score,
         sc.s_col, sc.s_type, sc.s_vendor, sc.s_tag, sc.s_trgm
       FROM cand c CROSS JOIN LATERAL (
         SELECT
           COALESCE(SUM(LEAST(cardinality(ARRAY(SELECT unnest(c.cols) INTERSECT SELECT unnest(s.seed_cols))), $4::int) * $6::numeric),0) AS s_col,
           COALESCE(SUM(CASE WHEN c.product_type IS NOT NULL AND c.product_type=s.seed_type THEN $7::numeric ELSE 0 END),0) AS s_type,
           COALESCE(SUM(CASE WHEN c.vendor IS NOT NULL AND c.vendor=s.seed_vendor THEN $8::numeric ELSE 0 END),0) AS s_vendor,
           COALESCE(SUM(LEAST(cardinality(ARRAY(SELECT DISTINCT lower(ct) FROM unnest(c.tags) ct INTERSECT SELECT DISTINCT lower(st) FROM unnest(s.seed_tags) st)), $5::int) * $9::numeric),0) AS s_tag,
           COALESCE(SUM($10::numeric * GREATEST(0, 1 - LEAST(CASE WHEN s.seed_price IS NULL OR c.price_min IS NULL THEN 1 ELSE abs(c.price_min - s.seed_price)/GREATEST(s.seed_price,1) END,1))),0) AS s_price,
           COALESCE(SUM($11::numeric * COALESCE(similarity(c.title, s.seed_title),0)),0) AS s_trgm
         FROM seeds s
       ) sc
     )
     SELECT product_id, score FROM scored
     WHERE (s_col + s_type + s_vendor + s_tag) > 0 OR s_trgm >= $12::numeric
     ORDER BY score DESC, title ASC, product_id ASC
     LIMIT $13::int`, p);
  return rows.map((r) => ({ id: r.product_id, score: Number(r.score) }));
}

interface Seed { gid: string; title: string; vendor: string; type: string; tags: string[]; price: string; cols?: string[]; }
let pc = 7;
const r = (m: number) => { pc = (pc * 1103515245 + 12345) & 0x7fffffff; return Math.floor(pc / 65536) % m; };
function randomCatalog(n: number, bigVendor = false): Seed[] {
  const vendors = ["Nike", "Adidas", "Puma", "Asics", "Reebok"]; const types = ["Shoe", "Sandal", "Boot", "Clog"];
  const tagsPool = ["Red", "red", "Sport", "blue", "sale", "new", "SPORT"]; const cols = ["gid://shopify/Collection/A", "gid://shopify/Collection/B", "gid://shopify/Collection/C"];
  const out: Seed[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      gid: `gid://shopify/Product/${i + 1}`, title: ["Running Shoe", "Trail Shoe", "Beach Sandal", "Winter Boot", "Garden Clog", "Sport Shoe"][r(6)] + " " + (i + 1),
      vendor: bigVendor ? "Nike" : vendors[r(vendors.length)], type: bigVendor ? "Shoe" : types[r(types.length)],
      tags: [tagsPool[r(tagsPool.length)], tagsPool[r(tagsPool.length)]], price: String(10 + r(90)),
      cols: r(2) === 0 ? [cols[r(cols.length)]] : [],
    });
  }
  return out;
}

describe("Phase 14b P5 — index-union rec candidates equal the scan-all query", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); pc = 7; shop = await db.resolveShop("p14b-rec.myshopify.com"); });

  async function seedAll(cat: Seed[]) {
    for (const s of cat) {
      await db.withShopExec(shop, async (e) => {
        const { id } = await upsertProduct(e, shop, {
          shopifyProductGid: s.gid, title: s.title, handle: s.gid.split("/").pop(), vendor: s.vendor, productType: s.type,
          status: "ACTIVE", tags: s.tags, onlineStoreUrl: `https://shop.test/${s.gid.split("/").pop()}`,
          featuredImageUrl: "https://img.test/x.jpg", featuredImageAlt: s.title, metafields: {},
        });
        await upsertVariant(e, shop, id, { shopifyVariantGid: s.gid + "/v1", sku: "SKU" + s.gid.split("/").pop(), price: s.price, availableForSale: true, position: 1 });
        for (const cg of s.cols ?? []) {
          await upsertCollection(e, shop, { shopifyCollectionGid: cg, title: cg.split("/").pop(), handle: cg.split("/").pop() });
          await replaceProductCollectionsByGids(e, shop, id, s.cols!);
        }
      });
    }
    const n = cat.length;
    const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
    return v.id;
  }

  const opts = (kind: ContentKind) => ({ kind, limit: 24, includeOutOfStock: false, diversifyPerVendor: 0, hideIds: [] as string[] });

  for (const kind of ["similar", "related"] as ContentKind[]) {
    it(`${kind}: identical to the scan-all reference on a random catalog`, async () => {
      const ver = await seedAll(randomCatalog(70));
      for (const seedGid of ["gid://shopify/Product/1", "gid://shopify/Product/25", "gid://shopify/Product/60"]) {
        const [ref, got] = await db.withShopExec(shop, async (e) => [
          await referenceRec(e, shop, ver, seedGid, kind),
          await recommendContent(e, shop, ver, [{ kind: "gid", value: seedGid }], opts(kind)),
        ]);
        expect(got.map((c) => c.id)).toEqual(ref.map((r) => r.id));
        got.forEach((c, i) => expect(c.score).toBeCloseTo(ref[i].score, 6));
      }
    });
  }

  it("worst case: seed shares a very large vendor+type — still identical", async () => {
    const ver = await seedAll(randomCatalog(120, /* bigVendor */ true));
    const [ref, got] = await db.withShopExec(shop, async (e) => [
      await referenceRec(e, shop, ver, "gid://shopify/Product/1", "similar"),
      await recommendContent(e, shop, ver, [{ kind: "gid", value: "gid://shopify/Product/1" }], opts("similar")),
    ]);
    expect(got.map((c) => c.id)).toEqual(ref.map((r) => r.id));
    // every candidate shares the vendor (big vendor) → the qualify gate admits
    // the whole catalog; the index union reproduces that exactly, capped at the limit.
    expect(got.length).toBe(24);
    expect(got.length).toBe(ref.length);
  });

  it("a candidate sharing ONLY a (case-variant) tag with the seed is still produced (tags branch is load-bearing)", async () => {
    // Seed and B share no vendor/type/collection and dissimilar titles; B shares
    // ONLY a tag, case-variant ("Sport" vs "sport"). B must appear — this is the
    // branch a mutation that drops the lowered-tags candidate would lose.
    const cat: Seed[] = [
      { gid: "gid://shopify/Product/1", title: "Alpha Widget", vendor: "VendorA", type: "TypeA", tags: ["Sport"], price: "10", cols: [] },
      { gid: "gid://shopify/Product/2", title: "Zeta Gadget", vendor: "VendorB", type: "TypeB", tags: ["sport"], price: "90", cols: [] },
      { gid: "gid://shopify/Product/3", title: "Omega Thing", vendor: "VendorC", type: "TypeC", tags: ["unrelated"], price: "50", cols: [] },
    ];
    const ver = await seedAll(cat);
    const [ref, got] = await db.withShopExec(shop, async (e) => [
      await referenceRec(e, shop, ver, "gid://shopify/Product/1", "related"),
      await recommendContent(e, shop, ver, [{ kind: "gid", value: "gid://shopify/Product/1" }], opts("related")),
    ]);
    expect(got.map((c) => c.id)).toEqual(ref.map((r) => r.id));
    // B (shares only the case-variant tag) qualifies; C (no shared attribute) does not.
    const gids = got.map((c) => c.gid);
    expect(gids).toContain("gid://shopify/Product/2");
    expect(gids).not.toContain("gid://shopify/Product/3");
  });

  it("multi-seed (recently-viewed style) is identical to summing the scan-all reference", async () => {
    const ver = await seedAll(randomCatalog(50));
    const seeds = ["gid://shopify/Product/2", "gid://shopify/Product/3"];
    const got = await db.withShopExec(shop, (e) => recommendContent(e, shop, ver, seeds.map((g) => ({ kind: "gid" as const, value: g })), opts("similar")));
    // reference: run the scan-all query with BOTH seeds (seeds CTE matches both).
    const w = WEIGHTS.similar;
    const ref = await db.withShopExec(shop, (e) => e.rows<{ product_id: string }>(
      `WITH seeds AS (SELECT product_id AS seed_id, title AS seed_title, vendor AS seed_vendor, product_type AS seed_type, tags AS seed_tags, price_min AS seed_price, ARRAY(SELECT jsonb_array_elements_text(doc->'collections')) AS seed_cols
         FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published AND status='ACTIVE' AND shopify_product_gid = ANY($3::text[])),
       cand AS (SELECT d.product_id, d.doc, d.title, d.vendor, d.product_type, d.tags, d.price_min, ARRAY(SELECT jsonb_array_elements_text(d.doc->'collections')) AS cols
         FROM product_search_doc d WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid AND d.published AND d.status='ACTIVE' AND d.available AND d.product_id NOT IN (SELECT seed_id FROM seeds)),
       scored AS (SELECT c.product_id, c.title,
         COALESCE(SUM(LEAST(cardinality(ARRAY(SELECT unnest(c.cols) INTERSECT SELECT unnest(s.seed_cols))),$4::int)*$6::numeric),0)
         + COALESCE(SUM(CASE WHEN c.product_type=s.seed_type THEN $7::numeric ELSE 0 END),0)
         + COALESCE(SUM(CASE WHEN c.vendor=s.seed_vendor THEN $8::numeric ELSE 0 END),0)
         + COALESCE(SUM(LEAST(cardinality(ARRAY(SELECT DISTINCT lower(ct) FROM unnest(c.tags) ct INTERSECT SELECT DISTINCT lower(st) FROM unnest(s.seed_tags) st)),$5::int)*$9::numeric),0)
         + COALESCE(SUM($10::numeric*GREATEST(0,1-LEAST(CASE WHEN s.seed_price IS NULL OR c.price_min IS NULL THEN 1 ELSE abs(c.price_min-s.seed_price)/GREATEST(s.seed_price,1) END,1))),0)
         + COALESCE(SUM($11::numeric*COALESCE(similarity(c.title,s.seed_title),0)),0) AS score,
         COALESCE(SUM(LEAST(cardinality(ARRAY(SELECT unnest(c.cols) INTERSECT SELECT unnest(s.seed_cols))),$4::int)),0)
         + COALESCE(SUM(CASE WHEN c.product_type=s.seed_type THEN 1 ELSE 0 END),0)
         + COALESCE(SUM(CASE WHEN c.vendor=s.seed_vendor THEN 1 ELSE 0 END),0)
         + COALESCE(SUM(cardinality(ARRAY(SELECT DISTINCT lower(ct) FROM unnest(c.tags) ct INTERSECT SELECT DISTINCT lower(st) FROM unnest(s.seed_tags) st))),0) AS attr,
         COALESCE(SUM($11::numeric*COALESCE(similarity(c.title,s.seed_title),0)),0) AS s_trgm
         FROM cand c CROSS JOIN LATERAL (SELECT 1) x, seeds s GROUP BY c.product_id, c.title)
       SELECT product_id FROM scored WHERE attr > 0 OR s_trgm >= $12::numeric ORDER BY score DESC, title ASC, product_id ASC LIMIT 24`,
      [shop, ver, seeds, w.collectionCap, w.tagCap, w.wCollection, w.wType, w.wVendor, w.wTag, w.wPrice, w.wTrgm, w.wTrgm * 0.3]));
    expect(got.map((c) => c.id)).toEqual(ref.map((r) => r.product_id));
  });
});
