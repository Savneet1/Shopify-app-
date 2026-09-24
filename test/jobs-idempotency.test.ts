import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { claimJob, markJob, beginJobAttempt } from "~/lib/sync/store";

/**
 * Job-level idempotency / deduplication + tenant ownership. This is engine-
 * agnostic: pg-boss provides singletonKey dedup at enqueue time, and this
 * claim provides idempotent processing (safe under duplicate Shopify events /
 * at-least-once delivery / worker restarts).
 */
describe("job idempotency, deduplication, tenant ownership", () => {
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

  it("claims a logical job once and dedupes duplicates", async () => {
    const first = await db.withShopExec(shopA, (e) =>
      claimJob(e, shopA, "catalog-sync", "bulk:run-1"),
    );
    const dup = await db.withShopExec(shopA, (e) =>
      claimJob(e, shopA, "catalog-sync", "bulk:run-1"),
    );
    const other = await db.withShopExec(shopA, (e) =>
      claimJob(e, shopA, "catalog-sync", "bulk:run-2"),
    );
    expect(first).toBe(true);
    expect(dup).toBe(false);
    expect(other).toBe(true);
  });

  it("the same dedupe key is independent across shops", async () => {
    expect(await db.withShopExec(shopA, (e) => claimJob(e, shopA, "q", "k1"))).toBe(true);
    expect(await db.withShopExec(shopB, (e) => claimJob(e, shopB, "q", "k1"))).toBe(true);
  });

  it("a worker cannot claim a job for another shop (RLS WITH CHECK)", async () => {
    await expect(
      db.withShopExec(shopB, (e) => claimJob(e, shopA, "q", "k-cross")),
    ).rejects.toThrow(/row-level security/i);
  });

  it("beginJobAttempt allows retries after failure but skips completed work", async () => {
    // first attempt proceeds
    const a1 = await db.withShopExec(shopA, (e) =>
      beginJobAttempt(e, shopA, "catalog-sync-full", "run-1"),
    );
    expect(a1).toEqual({ proceed: true, attempt: 1 });
    await db.withShopExec(shopA, (e) => markJob(e, shopA, "run-1", "failed", "boom"));

    // a retry of the still-unfinished job proceeds (attempt bumps)
    const a2 = await db.withShopExec(shopA, (e) =>
      beginJobAttempt(e, shopA, "catalog-sync-full", "run-1"),
    );
    expect(a2).toEqual({ proceed: true, attempt: 2 });
    await db.withShopExec(shopA, (e) => markJob(e, shopA, "run-1", "completed"));

    // once completed, a duplicate delivery is skipped
    const a3 = await db.withShopExec(shopA, (e) =>
      beginJobAttempt(e, shopA, "catalog-sync-full", "run-1"),
    );
    expect(a3.proceed).toBe(false);
  });

  it("markJob records completion", async () => {
    await db.withShopExec(shopA, (e) => claimJob(e, shopA, "q", "k9"));
    await db.withShopExec(shopA, (e) => markJob(e, shopA, "k9", "completed"));
    const rows = await db.withShopExec(shopA, (e) =>
      e.rows<{ status: string }>("SELECT status FROM job_audit WHERE shop_id=$1 AND dedupe_key=$2", [
        shopA,
        "k9",
      ]),
    );
    expect(rows[0].status).toBe("completed");
  });
});
