import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { saveAnalyticsSettings } from "~/lib/analytics/settings";
import { ingestEvents } from "~/lib/analytics/store";
import { PARTITION_RETENTION_DAYS } from "~/lib/analytics/settings";
import { listAnalyticsPartitions, analyticsMonthTargets } from "~/lib/analytics/retention";

/*
 * Phase 11.1 N1 — SECURITY DEFINER partition-function hardening (migration 0014).
 *
 * These run as app_runtime (db.rootExec / db.runtimePool use the app_runtime
 * role) from a shop-scoped context, i.e. exactly the privilege the real request
 * handlers and the worker hold. They prove that the two definer partition
 * functions cannot be abused — whatever argument any tenant passes — to destroy
 * or over-create partitions across tenants. The DB enforces the bounds itself
 * (defence in depth); the app never passes a hostile value, but the app is not
 * trusted here.
 */

// Count analytics_event partitions directly from the catalog (independent of the
// list function, so a test of the guards doesn't depend on another definer fn).
async function partitionNames(db: TestDb): Promise<string[]> {
  const { rows } = await db.runtimePool.query<{ relname: string }>(
    `SELECT c.relname
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'analytics_event'
     ORDER BY c.relname`,
  );
  return rows.map((r) => r.relname);
}

const ev = () => ({ eventType: "search_performed", surface: "search_page", query: "x", resultCount: 1 });
const iso = (d: Date) => d.toISOString();
const monthsFromNow = (k: number) => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + k, 15, 12, 0, 0));
};

describe("Phase 11.1 — app_drop_analytics_partitions_before is hard-floored (N1)", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p111dA.myshopify.com");
    shopB = await db.resolveShop("p111dB.myshopify.com");
    await db.withShopExec(shopA, (e) => saveAnalyticsSettings(e, shopA, { mode: "anonymous" }));
    await db.withShopExec(shopB, (e) => saveAnalyticsSettings(e, shopB, { mode: "anonymous" }));
    // Both shops hold a current-month event (routes to the current partition).
    await db.withShopExec(shopA, (e) => ingestEvents(e, shopA, [ev()], new Date()));
    await db.withShopExec(shopB, (e) => ingestEvents(e, shopB, [ev()], new Date()));
  });

  const countFor = (shopId: string) =>
    db.withShopExec(shopId, async (e) =>
      (await e.rows<{ n: number }>("SELECT count(*)::int n FROM analytics_event", []))[0].n);

  it("EXPLOIT DEFEATED: drop('2100-01-01') as app_runtime destroys NOTHING (both shops keep events)", async () => {
    const before = await partitionNames(db);
    const curName = analyticsMonthTargets(new Date())[0].name;
    expect(before).toContain(curName);
    expect(await countFor(shopA)).toBe(1);
    expect(await countFor(shopB)).toBe(1);

    // The original N1 attack: a far-future cutoff that, unclamped, dropped EVERY
    // partition for EVERY shop. Clamped to the hard floor, it CANNOT drop any
    // partition that could hold data newer than the 395-day cap — so the current
    // partition and both shops' recent events are guaranteed to survive. (It may
    // still drop genuinely-old partitions beyond the floor; that is correct and
    // not asserted here, since sibling tests leave such partitions around.)
    await db.rootExec.rows(
      "SELECT app_drop_analytics_partitions_before($1::timestamptz)", ["2100-01-01T00:00:00Z"],
    );

    const after = await partitionNames(db);
    expect(after).toContain(curName);          // current partition survives
    expect(after).toContain(analyticsMonthTargets(new Date())[1].name); // next month survives
    expect(await countFor(shopA)).toBe(1);      // shop A data intact
    expect(await countFor(shopB)).toBe(1);      // shop B data intact (cross-tenant)
  });

  it("a genuinely-old cutoff drops ONLY the old partition, keeps recent + both shops' data", async () => {
    // A real old partition would have been created long ago; simulate with an
    // owner-side raw CREATE (the range-guarded ensure() refuses a month this old).
    await db.ownerPool.query(
      `CREATE TABLE IF NOT EXISTS analytics_event_2024_01 PARTITION OF analytics_event
         FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')`,
    );
    expect(await partitionNames(db)).toContain("analytics_event_2024_01");

    // Cutoff older than the hard floor (now-395d ≈ 2025-09) so the clamp keeps it.
    const dropped = (await db.rootExec.rows<{ app_drop_analytics_partitions_before: number }>(
      "SELECT app_drop_analytics_partitions_before($1::timestamptz)", ["2024-07-01T00:00:00Z"],
    ))[0].app_drop_analytics_partitions_before;

    const after = await partitionNames(db);
    expect(after).not.toContain("analytics_event_2024_01");   // old dropped
    expect(after).toContain(analyticsMonthTargets(new Date())[0].name); // current kept
    expect(Number(dropped)).toBeGreaterThanOrEqual(1);
    expect(await countFor(shopA)).toBe(1);   // recent data untouched for both shops
    expect(await countFor(shopB)).toBe(1);
  });
});

describe("Phase 11.1 — app_ensure_analytics_partition is range-bounded (N1)", () => {
  let db: TestDb;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  const ensure = (d: Date) =>
    db.rootExec.rows<{ app_ensure_analytics_partition: string }>(
      "SELECT app_ensure_analytics_partition($1::timestamptz)", [iso(d)],
    );

  it("REJECTS out-of-range months (9999, 1900, now+4mo, now-15mo) and creates NOTHING", async () => {
    const before = await partitionNames(db);
    const outOfRange: Array<[string, Date]> = [
      ["year 9999", new Date(Date.UTC(9999, 0, 1, 12))],
      ["year 1900", new Date(Date.UTC(1900, 0, 1, 12))],
      ["now + 4 months", monthsFromNow(4)],
      ["now - 15 months", monthsFromNow(-15)],
    ];
    for (const [, d] of outOfRange) {
      await expect(ensure(d)).rejects.toThrow(/outside the allowed range/i);
    }
    const after = await partitionNames(db);
    expect(after).toEqual(before); // nothing created by any rejected call
  });

  it("ACCEPTS in-range months (now, +1, +2, +3, -14) and is idempotent", async () => {
    for (const k of [0, 1, 2, 3, -14]) {
      const d = monthsFromNow(k);
      const r1 = await ensure(d);
      expect(r1[0].app_ensure_analytics_partition).toMatch(/^analytics_event_\d{4}_\d{2}$/);
      const names = await partitionNames(db);
      expect(names).toContain(r1[0].app_ensure_analytics_partition);
      // Second call for the same month must not error and must not duplicate.
      const r2 = await ensure(d);
      expect(r2[0].app_ensure_analytics_partition).toBe(r1[0].app_ensure_analytics_partition);
      const names2 = await partitionNames(db);
      expect(names2.filter((n) => n === r1[0].app_ensure_analytics_partition).length).toBe(1);
    }
  });

  it("every month it creates has RLS ENABLED + FORCED and no app_runtime grant", async () => {
    const r = await ensure(monthsFromNow(3));
    const name = r[0].app_ensure_analytics_partition;
    const { rows } = await db.runtimePool.query<{ rls: boolean; forced: boolean }>(
      `SELECT relrowsecurity rls, relforcerowsecurity forced FROM pg_class WHERE relname = $1`, [name],
    );
    expect(rows[0].rls).toBe(true);
    expect(rows[0].forced).toBe(true);
    // No direct grant: app_runtime cannot select the partition relation directly.
    await expect(db.runtimePool.query(`SELECT count(*) FROM ${name}`)).rejects.toThrow(/permission denied/i);
  });
});

describe("Phase 11.1 — SECURITY DEFINER surface is allowlisted (N1)", () => {
  let db: TestDb;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  // The COMPLETE, reviewed set of SECURITY DEFINER functions app_runtime may
  // EXECUTE. Each is audited in docs/PHASE11.md with its cross-tenant surface.
  // If a new definer function is granted to app_runtime without being added
  // here (and audited), this test fails — forcing the review.
  const ALLOWLIST = new Set([
    "app_resolve_shop",
    "app_shops_needing_full_sync",
    "app_list_analytics_partitions",
    "app_ensure_analytics_partition",
    "app_drop_analytics_partitions_before",
    "app_analytics_hard_retention_days",
  ]);

  it("no SECURITY DEFINER function executable by app_runtime is outside the allowlist", async () => {
    const { rows } = await db.runtimePool.query<{ proname: string; args: string }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef = true
         AND has_function_privilege('app_runtime', p.oid, 'EXECUTE')
       ORDER BY p.proname`,
    );
    const found = rows.map((r) => r.proname);
    expect(found.length).toBeGreaterThan(0);
    for (const name of found) {
      expect(ALLOWLIST.has(name), `un-allowlisted SECURITY DEFINER fn executable by app_runtime: ${name}`).toBe(true);
    }
  });

  it("the hard-retention SQL constant matches the app constant (PARTITION_RETENTION_DAYS)", async () => {
    const { rows } = await db.runtimePool.query<{ d: number }>(
      "SELECT app_analytics_hard_retention_days()::int AS d",
    );
    expect(Number(rows[0].d)).toBe(PARTITION_RETENTION_DAYS);
    expect(PARTITION_RETENTION_DAYS).toBe(395);
  });
});
