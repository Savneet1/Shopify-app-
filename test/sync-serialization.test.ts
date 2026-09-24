import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { startSyncRun, isAlreadyRunning, recoverStaleRuns } from "~/lib/sync/store";
import { runFullSync } from "~/lib/sync/orchestrator";

const PRODUCTS_JSONL = `{"id":"gid://shopify/Product/1","title":"P1","updatedAt":"2026-01-01T00:00:00Z"}`;

/**
 * Per-shop full-sync serialization (#6). The DB partial-unique index
 * sync_run(shop_id) WHERE status='running' is the authoritative guard (in
 * addition to the pg-boss 'singleton' policy). A second concurrent full sync
 * cannot start.
 */
describe("full-sync serialization (single running per shop)", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;

  beforeAll(async () => {
    db = makeDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("shop-a.myshopify.com");
    shopB = await db.resolveShop("shop-b.myshopify.com");
  });

  it("a second running sync for the same shop is rejected by the DB guard", async () => {
    await db.withShopExec(shopA, (e) => startSyncRun(e, shopA, "bulk_full"));
    await expect(
      db.withShopExec(shopA, (e) => startSyncRun(e, shopA, "bulk_full")),
    ).rejects.toSatisfy((err) => isAlreadyRunning(err));
  });

  it("a different shop can run its own sync concurrently", async () => {
    await db.withShopExec(shopA, (e) => startSyncRun(e, shopA, "bulk_full"));
    const idB = await db.withShopExec(shopB, (e) => startSyncRun(e, shopB, "bulk_full"));
    expect(idB).toBeTruthy();
  });

  it("runFullSync returns already_running when a sync is in progress", async () => {
    // Simulate an in-flight run.
    await db.withShopExec(shopA, (e) => startSyncRun(e, shopA, "bulk_full"));
    const res = await runFullSync(db.withShopExec, shopA, {
      productsJsonl: PRODUCTS_JSONL,
      shopifyObjectCount: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("already_running");
  });

  it("recoverStaleRuns clears a crashed run so a new sync can start", async () => {
    await db.withShopExec(shopA, (e) => startSyncRun(e, shopA, "bulk_full"));
    // Force the running row to look stale (within the tenant RLS context).
    await db.withShopExec(shopA, (e) =>
      e.run(
        "UPDATE sync_run SET started_at = now() - interval '2 hours' WHERE shop_id=$1::uuid AND status='running'",
        [shopA],
      ),
    );
    const recovered = await db.withShopExec(shopA, (e) => recoverStaleRuns(e, shopA, 60));
    expect(recovered).toBe(1);
    // Now a fresh run can start.
    const id = await db.withShopExec(shopA, (e) => startSyncRun(e, shopA, "bulk_full"));
    expect(id).toBeTruthy();
  });

  it("empty product result with reported objects aborts (no catalog wipe)", async () => {
    await expect(
      runFullSync(db.withShopExec, shopA, { productsJsonl: "", shopifyObjectCount: 10 }),
    ).rejects.toThrow(/incomplete download|empty product result/i);
  });
});
