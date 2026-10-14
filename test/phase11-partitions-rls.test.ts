import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { makeDb, type TestDb } from "./helpers/db";
import { saveAnalyticsSettings } from "~/lib/analytics/settings";
import { ingestEvents } from "~/lib/analytics/store";
import { maintainAnalyticsPartitions, listAnalyticsPartitions } from "~/lib/analytics/retention";

/*
 * Phase 11.8 — partition maintenance (injected clock), RLS on parent AND
 * partitions with cross-shop isolation, and hostile-input robustness.
 * Migration 0013 applied to the test DB.
 */

describe("Phase 11 — partition maintenance (injected clock)", () => {
  let db: TestDb;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  const ensureAround = (iso: string) => maintainAnalyticsPartitions(db.rootExec, { now: new Date(iso) });

  it("creates current + next 2 months idempotently; second run is a no-op", async () => {
    const r1 = await ensureAround("2027-03-10T00:00:00Z");
    expect(r1.ensured).toEqual(["analytics_event_2027_03", "analytics_event_2027_04", "analytics_event_2027_05"]);
    const before = await listAnalyticsPartitions(db.rootExec);
    const r2 = await ensureAround("2027-03-10T00:00:00Z");
    const after = await listAnalyticsPartitions(db.rootExec);
    expect(after).toEqual(before); // running twice adds nothing
    expect(r2.ensured.length).toBe(3);
  });

  it("handles the Dec -> Jan boundary and a leap-day month", async () => {
    await ensureAround("2027-12-20T00:00:00Z");
    let parts = await listAnalyticsPartitions(db.rootExec);
    expect(parts).toContain("analytics_event_2027_12");
    expect(parts).toContain("analytics_event_2028_01");
    expect(parts).toContain("analytics_event_2028_02");
    // Feb 2028 is a leap month; ensure its range is valid by using it.
    await ensureAround("2028-02-29T23:59:59Z");
    parts = await listAnalyticsPartitions(db.rootExec);
    expect(parts).toContain("analytics_event_2028_02");
    expect(parts).toContain("analytics_event_2028_03");
  });

  it("drops partitions older than the hard retention cap, keeps recent", async () => {
    // Create a very old month, then run maintenance far in the future.
    await ensureAround("2025-01-15T00:00:00Z"); // creates 2025_01..03
    let parts = await listAnalyticsPartitions(db.rootExec);
    expect(parts).toContain("analytics_event_2025_01");
    // Far-future "now" so 2025_01 is well past the 395-day cap.
    const r = await maintainAnalyticsPartitions(db.rootExec, { now: new Date("2027-06-01T00:00:00Z") });
    expect(r.dropped).toBeGreaterThan(0);
    parts = await listAnalyticsPartitions(db.rootExec);
    expect(parts).not.toContain("analytics_event_2025_01");
    expect(parts).toContain("analytics_event_2027_06"); // current kept
  });
});

describe("Phase 11 — RLS on parent + partitions, cross-shop isolation", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p11rA.myshopify.com");
    shopB = await db.resolveShop("p11rB.myshopify.com");
    await db.withShopExec(shopA, (e) => saveAnalyticsSettings(e, shopA, { mode: "anonymous" }));
    await db.withShopExec(shopB, (e) => saveAnalyticsSettings(e, shopB, { mode: "anonymous" }));
  });
  const ev = () => ({ eventType: "search_performed", surface: "search_page", query: "x", resultCount: 1 });

  it("RLS is enabled + forced on the parent AND every partition", async () => {
    const { rows } = await db.runtimePool.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity rls, c.relforcerowsecurity forced
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND (c.relname='analytics_event' OR c.relname LIKE 'analytics_event_2%')
         AND c.relkind IN ('r','p')`,
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) { expect(r.rls).toBe(true); expect(r.forced).toBe(true); }
  });

  it("one shop's events are invisible to another via the parent", async () => {
    await db.withShopExec(shopA, (e) => ingestEvents(e, shopA, [ev()], new Date("2026-10-15T12:00:00Z")));
    const aCount = await db.withShopExec(shopA, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM analytics_event", []))[0].n);
    const bCount = await db.withShopExec(shopB, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM analytics_event", []))[0].n);
    expect(aCount).toBe(1);
    expect(bCount).toBe(0);
  });

  it("app_runtime cannot read or write a partition DIRECTLY (only via the parent)", async () => {
    await db.withShopExec(shopA, (e) => ingestEvents(e, shopA, [ev()], new Date("2026-10-15T12:00:00Z")));
    // Direct SELECT on the partition relation → permission denied for app_runtime.
    await expect(db.runtimePool.query("SELECT count(*) FROM analytics_event_2026_10")).rejects.toThrow(/permission denied/i);
    await expect(
      db.runtimePool.query("INSERT INTO analytics_event_2026_10 (shop_id,event_type,occurred_at,surface) VALUES (gen_random_uuid(),'search_performed',now(),'search_page')"),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("Phase 11 — hostile ingestion input never throws", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p11hA.myshopify.com");
    shopB = await db.resolveShop("p11hB.myshopify.com");
    await db.withShopExec(shopA, (e) => saveAnalyticsSettings(e, shopA, { mode: "anonymous" }));
  });

  it("drops junk (bad enum, injection strings, oversize, nested, huge ints, unknown keys) without throwing", async () => {
    const hostile = [
      { eventType: "'; DROP TABLE analytics_event; --", surface: "search_page" },
      { eventType: "search_performed", surface: "search_page", query: "'; DELETE FROM shop; --" }, // valid event, query is just text
      { eventType: "search_performed", surface: "search_page", position: 10 ** 18 },
      { eventType: "search_performed", surface: "search_page", nested: { a: { b: 1 } } },
      { eventType: "search_performed", surface: "search_page", productGid: "gid://shopify/Product/" + "9".repeat(40) },
      "not-an-object",
      12345,
      null,
    ];
    const r = await db.withShopExec(shopA, (e) => ingestEvents(e, shopA, hostile, new Date("2026-10-15T12:00:00Z")));
    // only ONE well-formed search_performed event (the one with a text query);
    // everything else is dropped individually.
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(7);
    // the injection string was stored as harmless normalized text, no SQL ran
    const n = await db.withShopExec(shopA, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM analytics_event", []))[0].n);
    expect(n).toBe(1);
    // shop table still intact (the "DELETE FROM shop" injection never ran):
    // the domain still resolves to the same shop id.
    expect(await db.resolveShop("p11hA.myshopify.com")).toBe(shopA);
  });

  it("an other-shop product gid is accepted as opaque text (never a cross-tenant leak)", async () => {
    // product_gid is just a validated string column; there is no FK/join to
    // another shop's catalog at write time, so a foreign gid is harmless.
    const r = await db.withShopExec(shopA, (e) => ingestEvents(e, shopA, [
      { eventType: "result_click", surface: "search_page", productGid: "gid://shopify/Product/999999" },
    ], new Date("2026-10-15T12:00:00Z")));
    expect(r.accepted).toBe(1);
    const bCount = await db.withShopExec(shopB, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM analytics_event", []))[0].n);
    expect(bCount).toBe(0); // shop B sees nothing
  });

  it("oversized batch is capped at 20", async () => {
    const many = Array.from({ length: 50 }, () => ({ eventType: "search_performed", surface: "search_page" }));
    const r = await db.withShopExec(shopA, (e) => ingestEvents(e, shopA, many, new Date("2026-10-15T12:00:00Z")));
    expect(r.accepted).toBe(20);
    expect(r.rejected).toBe(30);
  });
});
