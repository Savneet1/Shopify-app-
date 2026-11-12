import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { applyProductUpsert } from "~/lib/sync/orchestrator";
import type { NormalizedProduct } from "~/lib/catalog/bulk-parse";

/*
 * Phase 14d X3 — PLAN-STABILITY proof + mutation guard.
 *
 * Immediately after a bulk build, pg_class.reltuples for product_search_doc is -1
 * (a plain bulk INSERT never refreshes it). With no row estimate the planner
 * mis-estimates the per-product delta lookup and scans the whole shop via a
 * shop-scoped index instead of the unique (shop_id, index_version_id, product_id)
 * index — a ~35x write-path regression (docs/PHASE14D.md). The Phase 14d fix is an
 * automatic owner-side post-build ANALYZE (app/lib/jobs/analyze.server.ts), wired
 * into the full-sync handler. This test captures the REAL delta statements from a
 * live applyProductUpsert and asserts, via EXPLAIN, that:
 *   (fix)   AFTER the post-build ANALYZE, the delta statements use the unique
 *           index and never Seq-Scan product_search_doc.
 *   (guard) WITHOUT the ANALYZE (stale, as right after a raw build), the SAME
 *           vocabulary statement does NOT use the unique index. This is the
 *           mutation test: if the post-build ANALYZE were removed, the write path
 *           is left on this regressed plan — the assertion fails if the stale
 *           state does not actually regress, proving the ANALYZE is load-bearing.
 *
 * Plan-only EXPLAIN (no ANALYZE) is used so capturing a plan executes nothing.
 * autovacuum is disabled on the build tables for the duration so the stale capture
 * cannot be silently "fixed" by an autovacuum analyze firing mid-test; 2500 rows
 * put product_search_doc into the regime where reltuples=-1 changes the plan.
 */

const UNIQUE_INDEX = "product_search_doc_version_product_key";
const N = 2500;
const TABLES = ["product_search_doc", "product", "variant"];

function seedProduct(i: number): NormalizedProduct {
  return {
    product: {
      shopifyProductGid: `gid://shopify/Product/${i}`, title: `Running Shoe ${i}`, handle: `h${i}`,
      vendor: i % 3 ? "Nike" : "Adidas", productType: i % 2 ? "Shoe" : "Boot", status: "ACTIVE",
      tags: ["red", "sport"], onlineStoreUrl: `https://x.test/${i}`,
      featuredImageUrl: "https://img/x.jpg", featuredImageAlt: "x",
      metafields: { "custom.material": "Leather" }, combinedRole: null, combinedParentGid: null,
    },
    variants: [{ shopifyVariantGid: `gid://shopify/Product/${i}/v1`, sku: `S${i}`, price: String(5 + (i % 95)), availableForSale: true, position: 1 }],
    collectionGids: [], variantsComplete: true, collectionsComplete: true,
  } as NormalizedProduct;
}

function recordingExec(e: Exec, out: { sql: string; params: unknown[] }[]): Exec {
  return {
    rows: <T>(sql: string, params: unknown[] = []) => { out.push({ sql, params }); return e.rows<T>(sql, params); },
    run: (sql: string, params: unknown[] = []) => { out.push({ sql, params }); return e.run(sql, params); },
  };
}

describe("Phase 14d X3 — delta write-path plan stability", () => {
  let db: TestDb; let shop: string;
  const labels: string[] = [];
  const stalePlans: Record<string, string> = {};
  const freshPlans: Record<string, string> = {};

  beforeAll(async () => {
    db = makeDb();
    await db.resetDb();
    shop = await db.resolveShop("p14d-plan.myshopify.com");
    // Pin the stale window: no autovacuum analyze may fire mid-test.
    for (const t of TABLES) await db.ownerPool.query(`ALTER TABLE ${t} SET (autovacuum_enabled = false)`);

    const runner = db.withShopExec.bind(db);
    // Seed N products BEFORE any active version exists → applyProductUpsert only
    // writes product/variant rows (no delta maintenance), so seeding is cheap.
    for (let i = 1; i <= N; i++) await applyProductUpsert(runner, shop, seedProduct(i));
    const n0 = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
    const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n0));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n0));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));

    // Capture the REAL delta statements from a live update (version now active).
    const rec: { sql: string; params: unknown[] }[] = [];
    const recRunner = <T,>(sid: string, fn: (e: Exec) => Promise<T>) => db.withShopExec(sid, (e) => fn(recordingExec(e, rec)));
    await applyProductUpsert(recRunner as never, shop, seedProduct(1));
    const picked: { label: string; sql: string; params: unknown[] }[] = [];
    for (const r of rec) {
      let label = "";
      if (/INSERT INTO search_vocabulary/i.test(r.sql) && /product_search_doc/.test(r.sql)) label = "vocab delta";
      else if (/INSERT INTO search_facet_value/i.test(r.sql)) label = "facet_value delta";
      else if (/INSERT INTO search_suggest_term/i.test(r.sql)) label = "suggest delta";
      if (label && !picked.some((s) => s.label === label)) picked.push({ label, sql: r.sql, params: r.params });
    }
    labels.push(...picked.map((p) => p.label).sort());

    const planFor = (sql: string, params: unknown[]) => db.withShopExec(shop, async (e) =>
      (await e.rows<{ "QUERY PLAN": string }>(`EXPLAIN (FORMAT TEXT) ${sql}`, params)).map((r) => r["QUERY PLAN"]).join("\n"));

    // STALE: product_search_doc has never been analyzed (reltuples = -1).
    for (const p of picked) stalePlans[p.label] = await planFor(p.sql, p.params);
    // FIX: the automatic post-build ANALYZE (owner-side, fixed table list).
    for (const t of TABLES) await db.ownerPool.query(`ANALYZE ${t}`);
    for (const p of picked) freshPlans[p.label] = await planFor(p.sql, p.params);
  }, 180_000);

  afterAll(async () => {
    if (db) {
      for (const t of TABLES) await db.ownerPool.query(`ALTER TABLE ${t} SET (autovacuum_enabled = true)`).catch(() => {});
      await db.close();
    }
  });

  it("captured the real delta statements that read product_search_doc", () => {
    expect(labels).toEqual(["facet_value delta", "suggest delta", "vocab delta"]);
  });

  it("FIX: after post-build ANALYZE, every delta statement uses the unique index and never Seq-Scans", () => {
    for (const label of labels) {
      expect(freshPlans[label], `${label} should use ${UNIQUE_INDEX}`).toContain(UNIQUE_INDEX);
      expect(freshPlans[label], `${label} must not Seq Scan product_search_doc`).not.toMatch(/Seq Scan on product_search_doc/);
    }
  });

  it("GUARD: without the post-build ANALYZE, the vocab delta does NOT use the unique index (regression)", () => {
    // Load-bearing: if the post-build ANALYZE were removed, the heaviest delta
    // statement is left on this stale plan. The assertion fails if stale no longer
    // regresses, which is the signal to re-evaluate the fix.
    expect(stalePlans["vocab delta"], "stale vocab delta should NOT use the unique index").not.toContain(UNIQUE_INDEX);
  });
});
