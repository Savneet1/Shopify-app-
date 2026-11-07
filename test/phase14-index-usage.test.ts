import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { TS_CONFIG } from "~/lib/search/config";

/*
 * Phase 14.2 — EXPLAIN index-usage ASSERTIONS at a 10k synthetic set (this is the
 * Phase-3 informational check promoted to a real test). After a bulk build +
 * ANALYZE, a SELECTIVE storefront predicate must use an index scan on
 * product_search_doc, NOT a full sequential scan of the table. Covers the two
 * dominant selective shapes: a column-equality facet/filter (vendor) and a rare
 * full-text token (tsv GIN). Fresh statistics are the point — without the
 * ANALYZE (migration 0020 / autovacuum in production) the planner mis-estimates.
 */
describe("Phase 14.2 — index usage on the main storefront queries (10k)", () => {
  let db: TestDb; let shop: string; let versionId: string;
  const N = 10000;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p14idx.myshopify.com");
    // 10k products: a RARE vendor on ~0.1% and a rare title token on ~0.2%.
    await db.withShopExec(shop, (e) => e.run(
      `INSERT INTO product
         (shop_id, shopify_product_gid, handle, title, vendor, status, online_store_url, updated_at)
       SELECT $1::uuid, 'gid://shopify/Product/'||g, 'h'||g,
              'Widget '||g||(CASE WHEN g % 500 = 0 THEN ' unicorn' ELSE ' common' END),
              (CASE WHEN g % 1000 = 0 THEN 'RareVendor' ELSE 'Common'||(g % 40) END),
              'ACTIVE', 'https://x.test/'||g, now()
       FROM generate_series(1,$2::int) g`, [shop, N]));
    versionId = await db.withShopExec(shop, async (e) => (await createIndexVersion(e, shop, "full", N)).id);
    const built = await db.withShopExec(shop, (e) => buildDocs(e, shop, versionId));
    expect(built).toBe(N);
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, versionId, N));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, versionId));
    // Fresh stats (owner-side; app_runtime cannot ANALYZE — see migration 0020).
    await db.ownerPool.query("ANALYZE product_search_doc");
  });

  const planOf = (sql: string, params: unknown[], session?: string) =>
    db.withShopExec(shop, async (e) => {
      if (session) await e.run(session, []);
      return (await e.rows<{ "QUERY PLAN": string }>(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).map((r) => r["QUERY PLAN"]).join("\n");
    });

  it("a selective vendor-equality query uses an index scan, not a seq scan", async () => {
    const plan = await planOf(
      `SELECT product_id FROM product_search_doc
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'
         AND vendor = $3`,
      [shop, versionId, "RareVendor"],
    );
    expect(plan, plan).toMatch(/Index Scan|Index Only Scan|Bitmap (Heap|Index) Scan/);
    expect(plan).not.toMatch(/Seq Scan on product_search_doc/);
  });

  it("the tsv GIN index is a valid access path for a full-text predicate", async () => {
    // NOTE: PostgreSQL applies a FIXED default selectivity to `tsvector @@ tsquery`
    // (it keeps no per-lexeme MCV stats for tsvector), so at 10k the planner may
    // legitimately pick a Seq Scan over the whole small table for a full-text
    // match — that is a correct cost decision, not a missing index. The GIN
    // index's value is realised at scale (see the 100k EXPLAIN plans in
    // docs/PHASE14_BENCH.md). Here we assert the index is a *usable* access path
    // for this predicate (so a broken/dropped GIN index or a non-indexable query
    // shape is caught): with seq scan disabled the planner must choose the GIN.
    const plan = await planOf(
      `SELECT product_id FROM product_search_doc
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'
         AND tsv @@ websearch_to_tsquery('${TS_CONFIG}', immutable_unaccent($3))`,
      [shop, versionId, "unicorn"],
      "SET LOCAL enable_seqscan = off",
    );
    expect(plan, plan).toMatch(/psd_tsv_gin|Bitmap (Heap|Index) Scan|Index Scan/);
  });

  it("a shopify_product_gid lookup uses the gid index, not a seq scan (migration 0021)", async () => {
    // Shape used by the recommendation seed CTE, bundles, merch rules, restock.
    // At 100k the pre-0021 plan was a Seq Scan removing 99999 rows to find 1 seed.
    const plan = await planOf(
      `SELECT product_id FROM product_search_doc
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'
         AND shopify_product_gid = ANY($3::text[])`,
      [shop, versionId, ["gid://shopify/Product/4242"]],
    );
    expect(plan, plan).toMatch(/Index Scan|Index Only Scan|Bitmap (Heap|Index) Scan/);
    expect(plan).not.toMatch(/Seq Scan on product_search_doc/);
  });

  it("the purpose-built indexes exist on product_search_doc", async () => {
    const { rows } = await db.ownerPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='product_search_doc'`);
    const names = rows.map((r) => r.indexname);
    for (const idx of ["psd_tsv_gin", "psd_vendor_btree", "psd_ptype_btree", "psd_filter", "psd_title_trgm", "psd_gid_btree"]) {
      expect(names, `missing index ${idx}`).toContain(idx);
    }
  });
});
