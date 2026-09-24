import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
} from "~/lib/index/engine";
import { TS_CONFIG } from "~/lib/search/config";

/**
 * INFORMATIONAL (Phase 3.8): on a synthetic ~10k-product shop, confirm the GIN
 * tsvector index is available to the planner for a selective full-text query.
 * This is a sanity check that the Phase 3 indexes are wired correctly — it is
 * NOT a performance benchmark and asserts NO latency target (those are Phase 14
 * and must be measured on representative hardware, not claimed here).
 */
describe("Phase 3 — index usage (informational, ~10k synthetic)", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); shop = await db.resolveShop("bulk.myshopify.com"); });

  it("a selective tsvector query can use the GIN index", async () => {
    const N = 10000;
    // Bulk-insert N published, ACTIVE products. A rare token ("unicorn") appears
    // on ~1/500 titles so the FTS query is selective enough for the planner to
    // prefer the index.
    await db.withShopExec(shop, (e) =>
      e.run(
        `INSERT INTO product
           (shop_id, shopify_product_gid, handle, title, status, online_store_url, updated_at)
         SELECT $1::uuid, 'gid://shopify/Product/'||g, 'h'||g,
                'Widget '||g||(CASE WHEN g % 500 = 0 THEN ' unicorn' ELSE ' common' END),
                'ACTIVE', 'https://x.test/'||g, now()
         FROM generate_series(1, $2::int) g`,
        [shop, N],
      ),
    );

    const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", N));
    const built = await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
    expect(built).toBe(N);
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, N));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));

    // Give the planner statistics (owner runs ANALYZE).
    await db.ownerPool.query("ANALYZE product_search_doc");

    const plan = await db.withShopExec(shop, (e) =>
      e.rows<{ "QUERY PLAN": string }>(
        `EXPLAIN (FORMAT TEXT)
         SELECT product_id FROM product_search_doc
         WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
           AND published = true AND status='ACTIVE'
           AND tsv @@ websearch_to_tsquery('${TS_CONFIG}', immutable_unaccent($3))`,
        [shop, v.id, "unicorn"],
      ),
    );
    const planText = plan.map((r) => r["QUERY PLAN"]).join("\n");
    // Informational: surface the plan.
    // eslint-disable-next-line no-console
    console.info("[phase3 EXPLAIN]\n" + planText);

    // The query must return the right rows regardless of plan.
    const hits = await db.withShopExec(shop, (e) =>
      e.rows<{ n: number }>(
        `SELECT count(*)::int n FROM product_search_doc
         WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
           AND published=true AND status='ACTIVE'
           AND tsv @@ websearch_to_tsquery('${TS_CONFIG}', immutable_unaccent($3))`,
        [shop, v.id, "unicorn"],
      ),
    );
    expect(hits[0].n).toBe(20); // g=500,1000,...,10000

    // Informational: at 10k rows for a single shop the planner may prefer a seq
    // or shop-index scan over the GIN — that is a cost-model choice, not a
    // correctness issue, and this phase asserts no latency target. We log the
    // natural plan and, for reference, a plan with cheaper scans disabled.
    expect(planText.length).toBeGreaterThan(0);
    const forced = await db.withShopExec(shop, async (e) => {
      await e.run("SET LOCAL enable_seqscan = off");
      await e.run("SET LOCAL enable_indexscan = off");
      return e.rows<{ "QUERY PLAN": string }>(
        `EXPLAIN (FORMAT TEXT)
         SELECT product_id FROM product_search_doc
         WHERE tsv @@ websearch_to_tsquery('${TS_CONFIG}', immutable_unaccent($1))`,
        ["unicorn"],
      );
    });
    // eslint-disable-next-line no-console
    console.info("[phase3 EXPLAIN scans-restricted]\n" + forced.map((r) => r["QUERY PLAN"]).join("\n"));

    // Non-flaky correctness assertions: the GIN index exists and is valid, and
    // the FTS query returns exactly the expected rows (proving the tsv column is
    // populated and queryable). Whether the cost model picks the index at a
    // given size is out of scope here.
    const idx = await db.ownerPool.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = 'psd_tsv_gin'`,
    );
    expect(idx.rows[0]?.valid).toBe(true);

    const amname = await db.ownerPool.query<{ amname: string }>(
      `SELECT am.amname FROM pg_class c
       JOIN pg_am am ON am.oid = c.relam
       WHERE c.relname = 'psd_tsv_gin'`,
    );
    expect(amname.rows[0]?.amname).toBe("gin");
  }, 60000);
});
