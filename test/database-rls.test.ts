import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";

/**
 * Database + Row-Level Security tests (run against real PostgreSQL as the
 * app_runtime role). Covers the multi-tenant isolation guarantees that
 * withShop() + RLS provide, plus a representative cross-shop check.
 */
describe("database / RLS foundation", () => {
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

  it("runtime role is NOSUPERUSER and NOBYPASSRLS", async () => {
    const { rows } = await db.runtimePool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("RLS is enabled on every tenant-owned table", async () => {
    const { rows } = await db.runtimePool.query<{
      tablename: string;
      rowsecurity: boolean;
    }>(
      `SELECT tablename, rowsecurity FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('shop','app_setting','market','webhook_receipt',
                           'theme_compat_report','data_deletion_request',
                           'billing_subscription')`,
    );
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r.rowsecurity).toBe(true);
  });

  it("app_resolve_shop is idempotent (same domain -> same id)", async () => {
    const again = await db.resolveShop("shop-a.myshopify.com");
    expect(again).toBe(shopA);
    expect(shopA).not.toBe(shopB);
  });

  it("a shop can read its own rows", async () => {
    await db.withShopClient(shopA, (c) =>
      c.query(
        "INSERT INTO app_setting (shop_id, key, value) VALUES ($1,'theme','\"dawn\"')",
        [shopA],
      ),
    );
    const count = await db.withShopClient(shopA, async (c) => {
      const { rows } = await c.query("SELECT count(*)::int AS n FROM app_setting");
      return rows[0].n;
    });
    expect(count).toBe(1);
  });

  it("cross-shop READ is blocked (B cannot see A's rows)", async () => {
    await db.withShopClient(shopA, (c) =>
      c.query(
        "INSERT INTO app_setting (shop_id, key, value) VALUES ($1,'k','\"v\"')",
        [shopA],
      ),
    );
    const seenByB = await db.withShopClient(shopB, async (c) => {
      const { rows } = await c.query("SELECT count(*)::int AS n FROM app_setting");
      return rows[0].n;
    });
    expect(seenByB).toBe(0);
  });

  it("cross-shop WRITE is blocked (B cannot insert a row tagged as A)", async () => {
    await expect(
      db.withShopClient(shopB, (c) =>
        c.query(
          "INSERT INTO app_setting (shop_id, key, value) VALUES ($1,'x','\"y\"')",
          [shopA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("without tenant context, tenant tables are fail-closed (0 rows)", async () => {
    await db.withShopClient(shopA, (c) =>
      c.query(
        "INSERT INTO app_setting (shop_id, key, value) VALUES ($1,'k','\"v\"')",
        [shopA],
      ),
    );
    // No set_config here -> app_current_shop() is NULL -> policy denies.
    const { rows } = await db.runtimePool.query(
      "SELECT count(*)::int AS n FROM app_setting",
    );
    expect(rows[0].n).toBe(0);
  });
});
