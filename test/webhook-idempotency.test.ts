import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { CLAIM_WEBHOOK_SQL } from "~/lib/sql.server";

/**
 * Webhook idempotency: the claim insert must succeed exactly once per
 * (shop_id, webhook_id), and the claim is tenant-bound by RLS.
 */
describe("webhook receipt idempotency", () => {
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

  async function claim(shopId: string, webhookId: string): Promise<boolean> {
    return db.withShopClient(shopId, async (c) => {
      const { rows } = await c.query(CLAIM_WEBHOOK_SQL, [
        shopId,
        webhookId,
        "shop/redact",
        "2026-07",
        "hash",
      ]);
      return rows.length > 0;
    });
  }

  it("claims a webhook once and skips duplicates", async () => {
    expect(await claim(shopA, "wh_1")).toBe(true); // first delivery
    expect(await claim(shopA, "wh_1")).toBe(false); // duplicate/replay
    expect(await claim(shopA, "wh_2")).toBe(true); // different id
  });

  it("the same webhook id is independent across shops", async () => {
    expect(await claim(shopA, "wh_shared")).toBe(true);
    expect(await claim(shopB, "wh_shared")).toBe(true);
  });

  it("cannot record a receipt for another shop (RLS WITH CHECK)", async () => {
    await expect(
      db.withShopClient(shopB, (c) =>
        c.query(CLAIM_WEBHOOK_SQL, [shopA, "wh_x", "shop/redact", "2026-07", "h"]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
