import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { POST_BUILD_ANALYZE_TABLES } from "~/lib/jobs/analyze.server";

/*
 * Phase 14e E2 — the post-build ANALYZE runs as a dedicated LEAST-PRIVILEGE role
 * `app_maintenance` that OWNS ONLY the seven build-output tables (migration 0027)
 * and nothing else. These run as the REAL roles (maintenancePool = app_maintenance,
 * exactly what the worker's MAINTENANCE_DATABASE_URL holds) and prove the DB
 * itself enforces the boundary: the credential can ANALYZE the seven tables but
 * cannot read or write shop, session, email_setting, back_in_stock_subscription,
 * analytics_event or any other table, and app_runtime is unchanged.
 */

const MAINT_TABLES = [...POST_BUILD_ANALYZE_TABLES];
const FORBIDDEN = [
  "shop",
  "session",
  "email_setting",
  "back_in_stock_subscription",
  "analytics_event",
];

describe("Phase 14e E2 — app_maintenance least privilege (real roles)", () => {
  let db: TestDb;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  const maint = () => {
    if (!db.maintenancePool) throw new Error("TEST_MAINTENANCE_DATABASE_URL not set");
    return db.maintenancePool;
  };

  it("has a maintenance pool configured (TEST_MAINTENANCE_DATABASE_URL)", () => {
    expect(db.maintenancePool).not.toBeNull();
  });

  it("CAN ANALYZE each of the seven build-output tables", async () => {
    for (const t of MAINT_TABLES) {
      await expect(maint().query(`ANALYZE "${t}"`)).resolves.toBeDefined();
    }
  });

  it("owns exactly the seven tables; owns NONE of the forbidden tables", async () => {
    const { rows } = await db.ownerPool.query<{ relname: string; owner: string }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) owner
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
        WHERE c.relkind='r'`,
    );
    const owner = new Map(rows.map((r) => [r.relname, r.owner]));
    for (const t of MAINT_TABLES) expect(owner.get(t), `${t} should be app_maintenance-owned`).toBe("app_maintenance");
    for (const t of FORBIDDEN) expect(owner.get(t), `${t} must NOT be app_maintenance-owned`).not.toBe("app_maintenance");
  });

  it("holds NO table privilege (SELECT/INSERT/UPDATE/DELETE) on any forbidden table", async () => {
    for (const t of FORBIDDEN) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const { rows } = await db.ownerPool.query<{ ok: boolean }>(
          "SELECT has_table_privilege('app_maintenance', $1, $2) AS ok",
          [t, priv],
        );
        expect(rows[0].ok, `app_maintenance must NOT have ${priv} on ${t}`).toBe(false);
      }
    }
  });

  it("is DENIED at runtime when it tries to read or delete a forbidden table", async () => {
    for (const t of FORBIDDEN) {
      await expect(maint().query(`SELECT 1 FROM "${t}" LIMIT 1`)).rejects.toThrow(/permission denied/i);
      await expect(maint().query(`DELETE FROM "${t}"`)).rejects.toThrow(/permission denied/i);
    }
  });

  it("ANALYZE of a non-allowlisted table is refused by the DB (skipped with a permission warning)", async () => {
    const client = await maint().connect();
    const notices: string[] = [];
    client.on("notice", (n) => notices.push(n.message ?? ""));
    try {
      // PG16 ANALYZE on a non-owned table does not error — it emits a permission
      // WARNING and SKIPS the table, so its statistics are never refreshed.
      await client.query("ANALYZE shop");
    } finally {
      client.release();
    }
    expect(notices.join(" ")).toMatch(/permission denied to analyze/i);
  });

  it("app_runtime is UNCHANGED: still reads an app_maintenance-owned table under tenant RLS", async () => {
    await db.resetDb();
    const shopA = await db.resolveShop("p14eA.myshopify.com");
    // product_search_doc is now app_maintenance-owned; app_runtime must still be
    // able to query it under tenant context (its grant + RLS policy are intact).
    const rows = await db.withShopExec(shopA, (e) =>
      e.rows<{ n: number }>("SELECT count(*)::int AS n FROM product_search_doc"),
    );
    expect(rows[0].n).toBe(0);
  });

  it("MUTATION GUARD: if a build-output table were NOT handed to app_maintenance, it could not ANALYZE it", async () => {
    // Prove the ownership → ANALYZE-capability link is load-bearing WITHOUT
    // touching the seven shared tables (which parallel test files use): create a
    // throwaway table, confirm ANALYZE works only while app_maintenance owns it.
    const t = `p14e_mut_${process.pid}`;
    await db.ownerPool.query(`DROP TABLE IF EXISTS "${t}"`);
    await db.ownerPool.query(`CREATE TABLE "${t}" (id int)`);
    try {
      // owned by app_owner → app_maintenance cannot analyze (skip warning)
      const c1 = await maint().connect();
      const n1: string[] = [];
      c1.on("notice", (n) => n1.push(n.message ?? ""));
      try { await c1.query(`ANALYZE "${t}"`); } finally { c1.release(); }
      expect(n1.join(" "), "pre-mutation: non-owned table must be skipped").toMatch(/permission denied to analyze/i);

      // hand ownership to app_maintenance → now it CAN analyze (no skip warning)
      await db.ownerPool.query(`ALTER TABLE "${t}" OWNER TO app_maintenance`);
      const c2 = await maint().connect();
      const n2: string[] = [];
      c2.on("notice", (n) => n2.push(n.message ?? ""));
      try { await c2.query(`ANALYZE "${t}"`); } finally { c2.release(); }
      expect(n2.join(" "), "post-mutation: owned table analyzes cleanly").not.toMatch(/permission denied to analyze/i);
    } finally {
      await db.ownerPool.query(`DROP TABLE IF EXISTS "${t}"`);
    }
  });
});
