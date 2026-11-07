import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { resolveWindow, summaryReport, dailyTrend, perSurface } from "~/lib/analytics/reports";
import { rollupAnalyticsDaily, rollupCoverage } from "~/lib/analytics/rollup";

/*
 * Phase 14.6c — bounded daily rollup. Proves the long-range (90-day) reports
 * are BYTE-IDENTICAL whether served from raw analytics_event or from the
 * analytics_rollup_daily rollup, that the writer is correct + idempotent, that
 * the current (partial) day is merged from raw, and that the bounded writer
 * converges to full coverage over successive (tick-sized) runs.
 */
const NOW = new Date(); // real clock; seeding uses SQL now() → same UTC day
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

describe("Phase 14.6c — analytics daily rollup", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p14rollup.myshopify.com");
    await db.withShopExec(shop, async (e) => {
      // monthly partitions across the last 4 months
      await e.run(
        `SELECT app_ensure_analytics_partition((date_trunc('month', now()) - (g||' month')::interval)) FROM generate_series(0,4) g`, []);
      // ~40 events/day across days 1..89 (all COMPLETED) + 25 events TODAY (partial),
      // realistic event_type/surface mix and 50 distinct query_norm values.
      await e.run(
        `INSERT INTO analytics_event (shop_id, event_type, occurred_at, surface, query_norm, result_count)
         SELECT $1::uuid,
           (ARRAY['search_performed','search_performed','search_performed','result_click','result_click','search_zero_result','predictive_click','suggestion_click','recommendation_click','add_to_cart_from_search','redirect_followed','filter_applied'])[1 + (gs % 12)],
           date_trunc('day', now()) - ((1 + (gs % 89)) || ' day')::interval + ((gs % 80000) || ' second')::interval,
           (ARRAY['search_page','search_page','predictive','recommendation','bundle','redirect'])[1 + (gs % 6)],
           CASE WHEN gs % 12 < 6 THEN 'q' || (gs % 50) ELSE NULL END,
           (gs % 30)
         FROM generate_series(0, 89*40 - 1) gs`, [shop]);
      await e.run(
        `INSERT INTO analytics_event (shop_id, event_type, occurred_at, surface, query_norm, result_count)
         SELECT $1::uuid,
           (ARRAY['search_performed','result_click','search_zero_result','add_to_cart_from_search','recommendation_click'])[1 + (gs % 5)],
           date_trunc('day', now()) + ((gs % 3600) || ' second')::interval,
           (ARRAY['search_page','predictive','recommendation'])[1 + (gs % 3)],
           CASE WHEN gs % 2 = 0 THEN 'q' || (gs % 50) ELSE NULL END, 7
         FROM generate_series(0, 24) gs`, [shop]);
    });
  });

  // 90-day window (long-range: completed span ~89 days > 45) that includes today.
  const win = () => db.withShopExec(shop, (e) => resolveWindow(e, shop, { from: day(addDays(NOW, -89)), to: day(NOW) }, NOW));

  it("90-day reports are byte-identical raw vs rollup (incl. the partial current day)", async () => {
    const w = await win();
    // Before any rollup: rollup empty → reports take the raw path.
    const sRaw = await db.withShopExec(shop, (e) => summaryReport(e, shop, w, NOW));
    const tRaw = await db.withShopExec(shop, (e) => dailyTrend(e, shop, w, NOW));
    const pRaw = await db.withShopExec(shop, (e) => perSurface(e, shop, w, NOW));
    expect((await db.withShopExec(shop, (e) => rollupCoverage(e, shop, w.fromDay, day(addDays(NOW, -1))))).covered).toBe(false);

    // Populate the rollup in one shot (big backfill) → covers the completed window.
    await db.withShopExec(shop, (e) => rollupAnalyticsDaily(e, shop, { now: NOW, backfillDays: 120 }));
    expect((await db.withShopExec(shop, (e) => rollupCoverage(e, shop, w.fromDay, day(addDays(NOW, -1))))).covered).toBe(true);

    // After rollup: reports take the rollup+today path — must equal the raw results.
    const sRollup = await db.withShopExec(shop, (e) => summaryReport(e, shop, w, NOW));
    const tRollup = await db.withShopExec(shop, (e) => dailyTrend(e, shop, w, NOW));
    const pRollup = await db.withShopExec(shop, (e) => perSurface(e, shop, w, NOW));

    expect(sRollup).toEqual(sRaw);
    expect(tRollup).toEqual(tRaw);
    expect(pRollup).toEqual(pRaw);
    expect(sRaw.searches).toBeGreaterThan(0); // guard: the comparison was non-trivial
  });

  it("writer produces per-(day,event_type,surface) counts matching raw, and is idempotent", async () => {
    await db.withShopExec(shop, (e) => rollupAnalyticsDaily(e, shop, { now: NOW, backfillDays: 120 }));
    const pick = day(addDays(NOW, -10));
    const rawRows = await db.withShopExec(shop, (e) => e.rows<{ k: string; c: number }>(
      `SELECT event_type||'|'||surface AS k, count(*)::int AS c FROM analytics_event
       WHERE shop_id=$1::uuid AND (occurred_at AT TIME ZONE 'UTC')::date = $2::date GROUP BY 1 ORDER BY 1`, [shop, pick]));
    const rollupRows = await db.withShopExec(shop, (e) => e.rows<{ k: string; c: number }>(
      `SELECT event_type||'|'||surface AS k, event_count::int AS c FROM analytics_rollup_daily
       WHERE shop_id=$1::uuid AND day=$2::date ORDER BY 1`, [shop, pick]));
    expect(rollupRows).toEqual(rawRows);
    expect(rawRows.length).toBeGreaterThan(0);

    // Re-run: counts must not double (DELETE+INSERT per day).
    await db.withShopExec(shop, (e) => rollupAnalyticsDaily(e, shop, { now: NOW, backfillDays: 120 }));
    const rollupRows2 = await db.withShopExec(shop, (e) => e.rows<{ k: string; c: number }>(
      `SELECT event_type||'|'||surface AS k, event_count::int AS c FROM analytics_rollup_daily
       WHERE shop_id=$1::uuid AND day=$2::date ORDER BY 1`, [shop, pick]));
    expect(rollupRows2).toEqual(rawRows);
  });

  it("never rolls up the current (partial) day", async () => {
    await db.withShopExec(shop, (e) => rollupAnalyticsDaily(e, shop, { now: NOW, backfillDays: 120 }));
    const todayRollup = await db.withShopExec(shop, (e) => e.rows<{ c: number }>(
      `SELECT count(*)::int AS c FROM analytics_rollup_daily WHERE shop_id=$1::uuid AND day = (now() AT TIME ZONE 'UTC')::date`, [shop]));
    expect(todayRollup[0].c).toBe(0);
  });

  it("bounded writer converges to full coverage over successive runs", async () => {
    const completedTo = day(addDays(NOW, -1));
    const fromD = day(addDays(NOW, -89));
    // Default bounded run (refresh 2 + backfill 14) cannot cover 89 days at once.
    await db.withShopExec(shop, (e) => rollupAnalyticsDaily(e, shop, { now: NOW }));
    expect((await db.withShopExec(shop, (e) => rollupCoverage(e, shop, fromD, completedTo))).covered).toBe(false);
    // Successive ticks extend the rolled range backwards until it encloses the window.
    for (let i = 0; i < 10; i++) await db.withShopExec(shop, (e) => rollupAnalyticsDaily(e, shop, { now: NOW }));
    expect((await db.withShopExec(shop, (e) => rollupCoverage(e, shop, fromD, completedTo))).covered).toBe(true);
  });
});
