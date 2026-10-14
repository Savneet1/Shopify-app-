import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { saveAnalyticsSettings } from "~/lib/analytics/settings";
import { ingestEvents, deleteAllAnalytics } from "~/lib/analytics/store";
import {
  resolveWindow, summaryReport, topQueries, topZeroResultQueries, queriesWithNoClicks, perSurface, dailyTrend,
} from "~/lib/analytics/reports";
import {
  purgeOldAnalyticsEvents, maintainAnalyticsPartitions, listAnalyticsPartitions,
} from "~/lib/analytics/retention";

/*
 * Phase 11.8 — engine tests (node-postgres; migration 0013 applied). REAL-SHAPED
 * events sent through the same ingest + report code the proxy route uses.
 */
const GID = (n: number) => `gid://shopify/Product/${n}`;
const NOW = new Date("2026-10-15T12:00:00Z");

function ev(over: Record<string, unknown> = {}) {
  return { eventType: "search_performed", surface: "search_page", query: "red shoes", resultCount: 5, ...over };
}

describe("Phase 11 — analytics ingestion + reports engine", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p11.myshopify.com");
  });
  const setMode = (mode: string) => db.withShopExec(shop, (e) => saveAnalyticsSettings(e, shop, { mode: mode as any }));
  const ingest = (events: unknown, now = NOW) => db.withShopExec(shop, (e) => ingestEvents(e, shop, events, now));
  const count = () => db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM analytics_event WHERE shop_id=$1::uuid", [shop]))[0].n);

  it("mode OFF (default) stores nothing", async () => {
    const r = await ingest([ev(), ev({ eventType: "result_click", productGid: GID(1) })]);
    expect(r.accepted).toBe(0);
    expect(r.stored).toBe(0);
    expect(await count()).toBe(0);
  });

  it("anonymous mode stores events with NO session id (even if one is sent)", async () => {
    await setMode("anonymous");
    const r = await ingest([ev({ sessionId: "abc123" })]);
    expect(r.accepted).toBe(1);
    const rows = await db.withShopExec(shop, (e) => e.rows<{ session_id: string | null }>("SELECT session_id FROM analytics_event WHERE shop_id=$1::uuid", [shop]));
    expect(rows[0].session_id).toBeNull();
  });

  it("consented_sessions keeps a valid session id", async () => {
    await setMode("consented_sessions");
    await ingest([ev({ sessionId: "sess_ABC-1" })]);
    const rows = await db.withShopExec(shop, (e) => e.rows<{ session_id: string | null }>("SELECT session_id FROM analytics_event WHERE shop_id=$1::uuid", [shop]));
    expect(rows[0].session_id).toBe("sess_ABC-1");
  });

  it("server stamps occurred_at (a client ts is ignored)", async () => {
    await setMode("anonymous");
    await ingest([ev({ ts: 0 })], NOW); // ts=1970; occurred_at must be NOW
    const rows = await db.withShopExec(shop, (e) => e.rows<{ occurred_at: string }>("SELECT occurred_at FROM analytics_event WHERE shop_id=$1::uuid", [shop]));
    expect(new Date(rows[0].occurred_at).getUTCFullYear()).toBe(2026);
  });

  it("mixed valid/invalid batch: valid stored, invalid dropped individually", async () => {
    await setMode("anonymous");
    const r = await ingest([ev(), { eventType: "nope" }, ev({ surface: "moon" }), ev({ eventType: "result_click", productGid: GID(2) })]);
    expect(r.accepted).toBe(2);
    expect(r.rejected).toBe(2);
    expect(await count()).toBe(2);
  });

  it("reports are correct on a seeded event set (window applied)", async () => {
    await setMode("anonymous");
    await ingest([
      ev({ query: "red shoes", resultCount: 5 }),
      ev({ query: "red shoes", resultCount: 5 }),
      ev({ eventType: "search_zero_result", query: "zzzzz", resultCount: 0 }),
      ev({ eventType: "result_click", query: "red shoes", productGid: GID(1), position: 1 }),
      ev({ eventType: "add_to_cart_from_search", query: "red shoes", productGid: GID(1) }),
      ev({ eventType: "redirect_followed", query: "sale", surface: "redirect" }),
      ev({ eventType: "recommendation_click", surface: "recommendation", productGid: GID(9) }),
    ]);
    const w = await db.withShopExec(shop, (e) => resolveWindow(e, shop, {}, NOW));
    const s = await db.withShopExec(shop, (e) => summaryReport(e, shop, w));
    expect(s.searches).toBe(2);
    expect(s.zeroResults).toBe(1);
    expect(s.clicks).toBe(2); // result_click + recommendation_click
    expect(s.addToCartFromSearch).toBe(1);
    expect(s.redirects).toBe(1);
    expect(s.clickThroughRate).toBeCloseTo(1.0, 6); // 2 clicks / 2 searches

    const top = await db.withShopExec(shop, (e) => topQueries(e, shop, w));
    expect(top[0].query).toBe("red shoes");
    expect(top[0].searches).toBe(2);
    const zero = await db.withShopExec(shop, (e) => topZeroResultQueries(e, shop, w));
    expect(zero[0].query).toBe("zzzzz");
    const noClicks = await db.withShopExec(shop, (e) => queriesWithNoClicks(e, shop, w));
    expect(noClicks.find((r) => r.query === "red shoes")).toBeUndefined(); // it HAD clicks
    const surf = await db.withShopExec(shop, (e) => perSurface(e, shop, w));
    expect(surf.find((r) => r.surface === "search_page")!.events).toBeGreaterThan(0);
    const trend = await db.withShopExec(shop, (e) => dailyTrend(e, shop, w));
    expect(trend.length).toBeGreaterThan(0);
  });

  it("report query COUNTS: summary = 2 queries, each list = 1 (after window)", async () => {
    await setMode("anonymous");
    await ingest([ev()]);
    let n = 0;
    const counting = {
      rows: (sql: string, p?: unknown[]) => { n++; return (db as any).rootExec.rows(sql, p); },
      run: (sql: string, p?: unknown[]) => { n++; return (db as any).rootExec.run(sql, p); },
    };
    await db.withShopExec(shop, async (e) => {
      const wrap = { rows: (s: string, p?: unknown[]) => { n++; return e.rows(s, p as any); }, run: (s: string, p?: unknown[]) => { n++; return e.run(s, p as any); } };
      const w = await resolveWindow(wrap as any, shop, {}, NOW); // 1 query (settings)
      n = 0;
      await summaryReport(wrap as any, shop, w);
      expect(n).toBe(1); // summary aggregate = 1 query
      n = 0;
      await topQueries(wrap as any, shop, w);
      expect(n).toBe(1);
    });
    void counting;
  });

  it("window + retention: events outside the retention window are not reported, and are purged", async () => {
    await setMode("anonymous");
    await db.withShopExec(shop, (e) => saveAnalyticsSettings(e, shop, { retentionDays: 7 }));
    // one recent event, one 40 days old (needs its partition)
    await ingest([ev({ query: "recent" })], NOW);
    const old = new Date("2026-09-05T12:00:00Z"); // 40 days before NOW
    await db.withShopExec(shop, (e) => ingestEvents(e, shop, [ev({ query: "ancient" })], old));
    // report window clamps to 7 days -> only "recent"
    const w = await db.withShopExec(shop, (e) => resolveWindow(e, shop, {}, NOW));
    const top = await db.withShopExec(shop, (e) => topQueries(e, shop, w));
    expect(top.map((r) => r.query)).toContain("recent");
    expect(top.map((r) => r.query)).not.toContain("ancient");
    // purge removes the old row
    const del = await db.withShopExec(shop, (e) => purgeOldAnalyticsEvents(e, shop, { now: NOW }));
    expect(del).toBe(1);
    expect(await count()).toBe(1);
  });

  it("delete-all removes every analytics row for the shop", async () => {
    await setMode("anonymous");
    await ingest([ev(), ev({ eventType: "result_click", productGid: GID(1) })]);
    expect(await count()).toBe(2);
    const del = await db.withShopExec(shop, (e) => deleteAllAnalytics(e, shop));
    expect(del).toBeGreaterThanOrEqual(2);
    expect(await count()).toBe(0);
  });

  it("FK cascade: deleting the shop row removes its analytics rows", async () => {
    await setMode("anonymous");
    await ingest([ev()]);
    expect(await count()).toBe(1);
    // owner deletes the shop row -> ON DELETE CASCADE wipes analytics_event
    await (db as any).runtimePool; // noop ref
    await db.withShopExec(shop, async () => {});
    const ownerDeleted = await deleteShopRow(db, shop);
    expect(ownerDeleted).toBe(1);
    // re-resolve a fresh shop with the same domain would be a new id; assert the
    // partition holds no rows for the old shop id.
    const leftover = await (db as any).rootExec.rows(`SELECT count(*)::int n FROM analytics_event WHERE shop_id=$1::uuid`, [shop]);
    expect(leftover[0].n).toBe(0);
  });
});

/** Delete a shop row as owner (CASCADE). Uses the owner pool via a tiny helper. */
async function deleteShopRow(db: TestDb, shopId: string): Promise<number> {
  // The test helper exposes only runtime/root; delete via a direct owner query
  // using the same env URL the migrations used.
  const pg = await import("pg");
  const url = process.env.TEST_DIRECT_DATABASE_URL as string;
  const pool = new pg.default.Pool({ connectionString: url, max: 1 });
  try {
    const res = await pool.query("DELETE FROM shop WHERE id=$1::uuid", [shopId]);
    return res.rowCount ?? 0;
  } finally {
    await pool.end();
  }
}
