import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { makeDb, type TestDb } from "./helpers/db";
import { handleCatalogSyncFull } from "~/lib/jobs/handlers";
import {
  getActiveVersion, createIndexVersion, buildDocs, validateIndexVersion,
  activateIndexVersion, backfillActiveSearchColumns,
} from "~/lib/index/engine";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { countStaleCombinedDocs } from "~/lib/search/combined";

const PRODUCTS_JSONL = [
  `{"id":"gid://shopify/Product/1","title":"Red Shoe","vendor":"Acme","tags":["red"],"updatedAt":"2026-01-01T00:00:00Z"}`,
  `{"id":"gid://shopify/ProductVariant/11","sku":"SKU-11","price":"19.99","__parentId":"gid://shopify/Product/1"}`,
  `{"id":"gid://shopify/Product/2","title":"Blue Hat","vendor":"Acme","tags":["blue"],"updatedAt":"2026-01-01T00:00:00Z"}`,
].join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => Promise<boolean>, timeout = 12000, interval = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(interval);
  }
  throw new Error("waitFor timed out");
}

let rand = 0;
const tok = () => `${Date.now()}-${rand++}`;

/**
 * End-to-end pg-boss integration against real PostgreSQL: enqueue -> worker
 * picks up -> tenant-bound handler runs -> catalog synced + index activated;
 * plus enqueue deduplication and dead-letter routing on repeated failure.
 */
describe("pg-boss job pipeline (integration)", () => {
  let db: TestDb;
  let boss: PgBoss;
  let shopA: string;

  beforeAll(async () => {
    db = makeDb();
    boss = new PgBoss({
      connectionString: process.env.TEST_DATABASE_URL!,
      schema: "pgboss",
      migrate: false, // schema is installed once by app_owner (npm run pgboss:install)
    });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await db.close();
  });
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("shop-a.myshopify.com");
  });

  async function activeDocCount(shopId: string): Promise<number> {
    return db.withShopExec(shopId, async (e) => {
      const active = await getActiveVersion(e, shopId);
      if (!active) return 0;
      const rows = await e.rows<{ n: number }>(
        "SELECT count(*)::int n FROM product_search_doc WHERE shop_id=$1 AND index_version_id=$2",
        [shopId, active.id],
      );
      return rows[0].n;
    });
  }

  it("processes an enqueued full sync end-to-end (index becomes active)", async () => {
    const q = `it-full-${tok()}`;
    await boss.createQueue(q, { retryLimit: 1 });
    await boss.work<{ shopId: string; dedupeKey: string }>(
      q,
      { pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          await handleCatalogSyncFull(job.data, {
            runner: db.withShopExec,
            fetchBulkCatalog: async () => ({
              productsJsonl: PRODUCTS_JSONL,
              objectCount: 2,
            }),
          });
        }
      },
    );
    await boss.send(q, { shopId: shopA, dedupeKey: `d-${tok()}` });
    await waitFor(async () => (await activeDocCount(shopA)) === 2);
    expect(await activeDocCount(shopA)).toBe(2);
  });

  it("deduplicates repeated enqueue by singletonKey (processed once)", async () => {
    const q = `it-dedup-${tok()}`;
    const skey = `s-${tok()}`;
    let calls = 0;
    // 'short' policy drops a duplicate enqueue while one is still queued.
    await boss.createQueue(q, { policy: "short", retryLimit: 0 });
    await boss.work<{ shopId: string; dedupeKey: string }>(
      q,
      { pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          calls++;
          await handleCatalogSyncFull(job.data, {
            runner: db.withShopExec,
            fetchBulkCatalog: async () => ({ productsJsonl: PRODUCTS_JSONL, objectCount: 2 }),
          });
        }
      },
    );
    const key = `d-${tok()}`;
    await boss.send(q, { shopId: shopA, dedupeKey: key }, { singletonKey: skey });
    await boss.send(q, { shopId: shopA, dedupeKey: key }, { singletonKey: skey });
    await waitFor(async () => (await activeDocCount(shopA)) === 2);
    await sleep(1000);
    expect(calls).toBe(1); // second enqueue was deduped by singletonKey
  });

  it("G9: 'stately' policy caps queued full syncs per shop (repeated clicks don't pile up)", async () => {
    const q = `it-stately-${tok()}`;
    const skey = `shop-${tok()}`;
    await boss.createQueue(q, { policy: "stately" });
    // No worker: three enqueues with the same singletonKey collapse to one queued.
    await boss.send(q, { shopId: skey }, { singletonKey: skey });
    await boss.send(q, { shopId: skey }, { singletonKey: skey });
    await boss.send(q, { shopId: skey }, { singletonKey: skey });
    const rows = await db.runtimePool.query(
      "SELECT count(*)::int n FROM pgboss.job WHERE name=$1 AND singleton_key=$2 AND state='created'",
      [q, skey],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("Phase 13b C4: reindex-docs job backfills legacy combined docs; stately collapses repeats", async () => {
    // Seed a combined parent+child, build + activate, then null out the doc role
    // (legacy state). The reindex handler must re-project and clear the stale count.
    const g = (n: number) => `gid://shopify/Product/${n}`;
    const h = (x: string) => x.split("/").pop()!;
    const mk = async (gid: string, role: "PARENT" | "CHILD" | null, parent: string | null) =>
      db.withShopExec(shopA, async (e) => {
        const { id } = await upsertProduct(e, shopA, {
          shopifyProductGid: gid, title: "T" + h(gid), handle: h(gid), status: "ACTIVE",
          onlineStoreUrl: "https://shop-a/products/" + h(gid), metafields: {},
          shopifyUpdatedAt: "2024-01-01", combinedRole: role, combinedParentGid: parent,
        });
        await upsertVariant(e, shopA, id, { shopifyVariantGid: gid + "/v", price: "9.00", availableForSale: true });
      });
    await mk(g(1), "PARENT", null);
    await mk(g(2), "CHILD", g(1));
    await db.withShopExec(shopA, async (e) => {
      const v = await createIndexVersion(e, shopA, "full", 2);
      await buildDocs(e, shopA, v.id);
      await validateIndexVersion(e, shopA, v.id, 2);
      await activateIndexVersion(e, shopA, v.id);
    });
    await db.withShopExec(shopA, (e) => e.run(
      `UPDATE product_search_doc d SET combined_role=NULL FROM index_version iv
       WHERE iv.id=d.index_version_id AND iv.status='active' AND d.shop_id=$1::uuid`, [shopA]));
    expect(await db.withShopExec(shopA, (e) => countStaleCombinedDocs(e, shopA))).toBe(2);

    const q = `it-reindex-${tok()}`;
    const skey = `reindex-docs:${shopA}`;
    let calls = 0;
    await boss.createQueue(q, { policy: "stately" });
    await boss.work<{ shopId: string }>(q, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
      for (const job of jobs) { calls++; await db.withShopExec(job.data.shopId, (e) => backfillActiveSearchColumns(e, job.data.shopId)); }
    });
    await boss.send(q, { shopId: shopA }, { singletonKey: skey });
    await boss.send(q, { shopId: shopA }, { singletonKey: skey }); // collapses (stately)
    await waitFor(async () => (await db.withShopExec(shopA, (e) => countStaleCombinedDocs(e, shopA))) === 0);
    await sleep(800);
    expect(calls).toBe(1); // repeats deduped by singletonKey
    expect(await db.withShopExec(shopA, (e) => countStaleCombinedDocs(e, shopA))).toBe(0);
  });

  it("routes a repeatedly failing job to its dead-letter queue", async () => {
    const q = `it-fail-${tok()}`;
    const dlq = `${q}-dlq`;
    await boss.createQueue(dlq);
    await boss.createQueue(q, { retryLimit: 0, deadLetter: dlq });
    await boss.work(q, { pollingIntervalSeconds: 0.5 }, async () => {
      throw new Error("always fails");
    });
    await boss.send(q, { shopId: shopA });
    await waitFor(async () => {
      const rows = await db.runtimePool.query(
        "SELECT count(*)::int n FROM pgboss.job WHERE name=$1",
        [dlq],
      );
      return rows.rows[0].n >= 1;
    });
    const dead = await db.runtimePool.query(
      "SELECT count(*)::int n FROM pgboss.job WHERE name=$1",
      [dlq],
    );
    expect(dead.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
