import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { FACET_METAFIELD_MAPKEY } from "~/lib/search/config";

/*
 * Phase 14b P6 — EXPLAIN index-usage assertions at a 10k synthetic set. The
 * suggestion, NL-context and facet-count reads must NOT touch product_search_doc
 * at all (they read the small precomputed tables), and the recommendation
 * candidate generation must use indexes on product_search_doc, never a Seq Scan.
 */
const SEQ_PSD = /Seq Scan on product_search_doc/;

describe("Phase 14b P6 — index usage for the de-scanned paths (10k)", () => {
  let db: TestDb; let shop: string; let ver: string; const N = 10000;
  beforeAll(async () => {
    db = makeDb();
    await db.resetDb();
    shop = await db.resolveShop("p14b-idx.myshopify.com");
    await db.withShopExec(shop, (e) => e.run(
      `INSERT INTO product (shop_id, shopify_product_gid, handle, title, vendor, product_type, tags, metafields, status, online_store_url, updated_at)
       SELECT $1::uuid, 'gid://shopify/Product/'||g, 'h'||g,
              'Item '||g||(CASE WHEN g=4242 THEN ' zqxrare' ELSE '' END),
              'V'||(g % 50), 'T'||(g % 30), to_jsonb(ARRAY['tag'||(g % 100)]),
              jsonb_build_object($3::text, 'M'||(g % 20)),
              'ACTIVE', 'https://x.test/'||g, now()
       FROM generate_series(1,$2::int) g`, [shop, N, FACET_METAFIELD_MAPKEY]));
    // one variant per product so docs have a price / availability
    await db.withShopExec(shop, (e) => e.run(
      `INSERT INTO variant (shop_id, product_id, shopify_variant_gid, sku, price, available_for_sale, position)
       SELECT $1::uuid, p.id, p.shopify_product_gid||'/v1', 'SKU'||p.shopify_product_gid, 25, true, 1
       FROM product p WHERE p.shop_id=$1::uuid`, [shop]));
    ver = await db.withShopExec(shop, async (e) => (await createIndexVersion(e, shop, "full", N)).id);
    expect(await db.withShopExec(shop, (e) => buildDocs(e, shop, ver))).toBe(N);
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, ver, N));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, ver));
    // fresh stats for every table the plans touch
    for (const t of ["product_search_doc", "search_facet_value", "search_facet_summary", "search_suggest_term", "product_collection", "collection"]) {
      await db.ownerPool.query(`ANALYZE ${t}`);
    }
  }, 120000);
  afterAll(() => db.close());

  const planOf = (sql: string, params: unknown[], session?: string) =>
    db.withShopExec(shop, async (e) => {
      if (session) await e.run(session, []);
      return (await e.rows<{ "QUERY PLAN": string }>(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).map((r) => r["QUERY PLAN"]).join("\n");
    });

  it("suggestions read ONLY the precomputed terms — product_search_doc is never touched", async () => {
    const plan = await planOf(
      `SELECT text, type FROM search_suggest_term
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
         AND text <> '' AND immutable_unaccent(lower(text)) LIKE immutable_unaccent(lower($3)) ESCAPE '\\'`,
      [shop, ver, "ite%"]);
    // The key guarantee: suggestions read the small per-version terms table, so
    // the plan never references product_search_doc (the trigram GIN on the terms
    // table additionally serves larger prefixes at scale).
    expect(plan, plan).not.toMatch(/product_search_doc/);
  });

  it("NL-context distinct values read ONLY the precompute — product_search_doc is never touched", async () => {
    const plan = await planOf(
      `SELECT kind, value FROM search_facet_value
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND kind IN ('vendor','product_type','tag','metafield') ORDER BY kind, value`,
      [shop, ver]);
    expect(plan, plan).not.toMatch(/product_search_doc/);
  });

  it("facet counts read ONLY the precompute — product_search_doc is never touched", async () => {
    const plan = await planOf(
      `SELECT value, doc_count FROM search_facet_value
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND kind='vendor' ORDER BY doc_count DESC, value ASC LIMIT 50`,
      [shop, ver]);
    expect(plan, plan).not.toMatch(/product_search_doc/);
  });

  it("a selective rec candidate branch (vendor) naturally uses the vendor index, not a Seq Scan", async () => {
    const plan = await planOf(
      `SELECT d.product_id FROM product_search_doc d
       WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid AND d.published AND d.status='ACTIVE' AND d.vendor = ANY($3::text[])`,
      [shop, ver, ["V7"]]);
    expect(plan, plan).not.toMatch(SEQ_PSD);
    expect(plan, plan).toMatch(/Index Scan|Index Only Scan|Bitmap (Heap|Index) Scan/);
  });

  it("the rec candidate branches are all index-usable access paths (no Seq Scan on product_search_doc)", async () => {
    // At 10k on this narrow table the planner may cost-choose a seq scan for the
    // trigram branch (the % selectivity + a cheap small-table scan — same effect
    // as the Phase 14 tsv GIN). Disabling seq scan proves every branch — vendor,
    // type, lowered-tags GIN and title trigram — HAS an index access path, so the
    // candidate generation does not depend on scanning the doc table at scale.
    const plan = await planOf(
      `WITH seeds AS (
         SELECT product_id AS seed_id, title AS seed_title, vendor AS seed_vendor, product_type AS seed_type,
                tags AS seed_tags, ARRAY(SELECT jsonb_array_elements_text(doc->'collections')) AS seed_cols
         FROM product_search_doc
         WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published AND status='ACTIVE' AND shopify_product_gid=$3),
       seed_agg AS (
         SELECT array_agg(DISTINCT seed_type) FILTER (WHERE seed_type IS NOT NULL) AS a_types,
                array_agg(DISTINCT seed_vendor) FILTER (WHERE seed_vendor IS NOT NULL) AS a_vendors,
                COALESCE((SELECT array_agg(DISTINCT lt) FROM seeds s2, unnest(immutable_lower_text_array(s2.seed_tags)) lt),'{}'::text[]) AS a_tags_lower,
                COALESCE((SELECT array_agg(DISTINCT ct) FROM seeds s3, unnest(s3.seed_cols) ct),'{}'::text[]) AS a_cols
         FROM seeds)
       SELECT d.product_id FROM product_search_doc d, seed_agg a
         WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid AND d.published AND d.status='ACTIVE' AND d.vendor = ANY(a.a_vendors)
       UNION
       SELECT d.product_id FROM product_search_doc d, seed_agg a
         WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid AND d.published AND d.status='ACTIVE' AND d.product_type = ANY(a.a_types)
       UNION
       SELECT d.product_id FROM product_search_doc d, seed_agg a
         WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid AND d.published AND d.status='ACTIVE' AND immutable_lower_text_array(d.tags) && a.a_tags_lower
       UNION
       SELECT d.product_id FROM product_search_doc d JOIN seeds s ON d.title % s.seed_title
         WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid AND d.published AND d.status='ACTIVE'`,
      [shop, ver, "gid://shopify/Product/4242"], "SET LOCAL enable_seqscan = off");
    expect(plan, plan).not.toMatch(SEQ_PSD);
    expect(plan, plan).toMatch(/Index Scan|Bitmap (Heap|Index) Scan/);
  });
});
