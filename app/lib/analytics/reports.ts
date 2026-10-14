import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { loadAnalyticsSettings } from "./settings";

/**
 * Phase 11.4 — reporting. Parameterized queries over analytics_event, ALWAYS
 * with a date window, and ALWAYS clamped to the shop's retention cap (so a
 * report can never read past what retention keeps). All reads are RLS-scoped
 * (run under withShop). CTR here is the session-free definition:
 *   CTR = (result_click + predictive_click + suggestion_click) / search_performed
 * over the window — a ratio of event counts, not a per-session rate.
 *
 * QUERY COUNTS (hot path = the dashboard summary): `summaryReport` issues
 * exactly 2 queries (1 to load settings/clamp the window, 1 aggregate). Each
 * list report (`topQueries`, `topZeroResultQueries`, `queriesWithNoClicks`,
 * `perSurface`, `dailyTrend`) is 1 aggregate query after the window is known.
 */

export interface DateWindow { fromDay: string; toDay: string } // 'YYYY-MM-DD'

/** Resolve the effective window: caller's range, clamped to [now-retention, now]. */
export async function resolveWindow(
  exec: Exec, shopId: string, req: { from?: string | null; to?: string | null }, now: Date = new Date(),
): Promise<DateWindow> {
  const { retentionDays } = await loadAnalyticsSettings(exec, shopId);
  const toDefault = new Date(now);
  const fromDefault = new Date(now.getTime() - 29 * 86400_000); // default 30-day window
  const retentionFloor = new Date(now.getTime() - retentionDays * 86400_000);
  const parse = (s: string | null | undefined, dflt: Date): Date => {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return dflt;
    const d = new Date(s + "T00:00:00Z");
    return isNaN(d.getTime()) ? dflt : d;
  };
  let from = parse(req.from, fromDefault);
  let to = parse(req.to, toDefault);
  if (from < retentionFloor) from = retentionFloor;        // clamp to retention
  if (to > now) to = now;
  if (from > to) from = new Date(to.getTime() - 86400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { fromDay: day(from), toDay: day(to) };
}

/** window predicate on occurred_at, inclusive of both day bounds (UTC). */
function windowPredicate(pb: Params, w: DateWindow): string {
  const f = pb.add(w.fromDay);
  const t = pb.add(w.toDay);
  return `occurred_at >= (${f}::date) AND occurred_at < ((${t}::date) + 1)`;
}

const CLICK_TYPES = ["result_click", "predictive_click", "suggestion_click", "recommendation_click"];

export interface SummaryReport {
  window: DateWindow;
  searches: number;
  zeroResults: number;
  zeroResultRate: number;
  clicks: number;
  clickThroughRate: number;
  addToCartFromSearch: number;
  addToCartRate: number;
  redirects: number;
}

export async function summaryReport(
  exec: Exec, shopId: string, w: DateWindow,
): Promise<SummaryReport> {
  const pb = new Params();
  const sid = pb.add(shopId);
  const win = windowPredicate(pb, w);
  const clicks = pb.add(CLICK_TYPES);
  const rows = await exec.rows<{
    searches: number; zero: number; clicks: number; atc: number; redirects: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE event_type='search_performed')::int AS searches,
       count(*) FILTER (WHERE event_type='search_zero_result')::int AS zero,
       count(*) FILTER (WHERE event_type = ANY(${clicks}::text[]))::int AS clicks,
       count(*) FILTER (WHERE event_type='add_to_cart_from_search')::int AS atc,
       count(*) FILTER (WHERE event_type='redirect_followed')::int AS redirects
     FROM analytics_event
     WHERE shop_id=${sid}::uuid AND ${win}`,
    pb.values,
  );
  const r = rows[0] ?? { searches: 0, zero: 0, clicks: 0, atc: 0, redirects: 0 };
  const searches = Number(r.searches);
  const ratio = (num: number) => (searches > 0 ? num / searches : 0);
  return {
    window: w,
    searches,
    zeroResults: Number(r.zero),
    zeroResultRate: ratio(Number(r.zero)),
    clicks: Number(r.clicks),
    clickThroughRate: ratio(Number(r.clicks)),
    addToCartFromSearch: Number(r.atc),
    addToCartRate: ratio(Number(r.atc)),
    redirects: Number(r.redirects),
  };
}

export interface QueryRow { query: string; searches: number; clicks: number; zeroResults: number }

/** Top queries by search volume (excludes null/redacted-to-empty queries). */
export async function topQueries(exec: Exec, shopId: string, w: DateWindow, limit = 20): Promise<QueryRow[]> {
  const pb = new Params();
  const sid = pb.add(shopId);
  const win = windowPredicate(pb, w);
  const lim = pb.add(Math.max(1, Math.min(200, Math.floor(limit))));
  const clicks = pb.add(CLICK_TYPES);
  return exec.rows<QueryRow>(
    `SELECT query_norm AS query,
       count(*) FILTER (WHERE event_type='search_performed')::int AS searches,
       count(*) FILTER (WHERE event_type = ANY(${clicks}::text[]))::int AS clicks,
       count(*) FILTER (WHERE event_type='search_zero_result')::int AS "zeroResults"
     FROM analytics_event
     WHERE shop_id=${sid}::uuid AND ${win} AND query_norm IS NOT NULL
     GROUP BY query_norm
     HAVING count(*) FILTER (WHERE event_type='search_performed') > 0
     ORDER BY searches DESC, query ASC
     LIMIT ${lim}::int`,
    pb.values,
  );
}

export async function topZeroResultQueries(exec: Exec, shopId: string, w: DateWindow, limit = 20): Promise<QueryRow[]> {
  const pb = new Params();
  const sid = pb.add(shopId);
  const win = windowPredicate(pb, w);
  const lim = pb.add(Math.max(1, Math.min(200, Math.floor(limit))));
  return exec.rows<QueryRow>(
    `SELECT query_norm AS query,
       0::int AS searches,
       0::int AS clicks,
       count(*)::int AS "zeroResults"
     FROM analytics_event
     WHERE shop_id=${sid}::uuid AND ${win} AND event_type='search_zero_result' AND query_norm IS NOT NULL
     GROUP BY query_norm
     ORDER BY "zeroResults" DESC, query ASC
     LIMIT ${lim}::int`,
    pb.values,
  );
}

/** Queries that were searched but produced no click of any kind in the window. */
export async function queriesWithNoClicks(exec: Exec, shopId: string, w: DateWindow, limit = 20): Promise<QueryRow[]> {
  const pb = new Params();
  const sid = pb.add(shopId);
  const win = windowPredicate(pb, w);
  const clicks = pb.add(CLICK_TYPES);
  const lim = pb.add(Math.max(1, Math.min(200, Math.floor(limit))));
  return exec.rows<QueryRow>(
    `SELECT query_norm AS query,
       count(*) FILTER (WHERE event_type='search_performed')::int AS searches,
       0::int AS clicks,
       count(*) FILTER (WHERE event_type='search_zero_result')::int AS "zeroResults"
     FROM analytics_event
     WHERE shop_id=${sid}::uuid AND ${win} AND query_norm IS NOT NULL
     GROUP BY query_norm
     HAVING count(*) FILTER (WHERE event_type='search_performed') > 0
        AND count(*) FILTER (WHERE event_type = ANY(${clicks}::text[])) = 0
     ORDER BY searches DESC, query ASC
     LIMIT ${lim}::int`,
    pb.values,
  );
}

export interface SurfaceRow { surface: string; events: number }
export async function perSurface(exec: Exec, shopId: string, w: DateWindow): Promise<SurfaceRow[]> {
  const pb = new Params();
  const sid = pb.add(shopId);
  const win = windowPredicate(pb, w);
  return exec.rows<SurfaceRow>(
    `SELECT surface, count(*)::int AS events FROM analytics_event
     WHERE shop_id=${sid}::uuid AND ${win}
     GROUP BY surface ORDER BY events DESC, surface ASC`,
    pb.values,
  );
}

export interface TrendRow { day: string; searches: number; clicks: number; zeroResults: number; addToCart: number }
export async function dailyTrend(exec: Exec, shopId: string, w: DateWindow): Promise<TrendRow[]> {
  const pb = new Params();
  const sid = pb.add(shopId);
  const win = windowPredicate(pb, w);
  const clicks = pb.add(CLICK_TYPES);
  return exec.rows<TrendRow>(
    `SELECT to_char((occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
       count(*) FILTER (WHERE event_type='search_performed')::int AS searches,
       count(*) FILTER (WHERE event_type = ANY(${clicks}::text[]))::int AS clicks,
       count(*) FILTER (WHERE event_type='search_zero_result')::int AS "zeroResults",
       count(*) FILTER (WHERE event_type='add_to_cart_from_search')::int AS "addToCart"
     FROM analytics_event
     WHERE shop_id=${sid}::uuid AND ${win}
     GROUP BY 1 ORDER BY 1 ASC`,
    pb.values,
  );
}
