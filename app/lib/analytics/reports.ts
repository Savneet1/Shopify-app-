import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { loadAnalyticsSettings } from "./settings";
import { rollupCoverage, daysInclusive, ROLLUP_MIN_WINDOW_DAYS } from "./rollup";

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

/**
 * Phase 14.6c — rollup read helpers. The event_type/surface reports
 * (summaryReport, dailyTrend, perSurface) read analytics_rollup_daily for the
 * COMPLETED-day portion of the window when it is fully covered, and raw
 * analytics_event only for the current (partial) day — a few thousand rollup
 * rows instead of millions of raw rows. If the rollup does not yet enclose the
 * completed window (e.g. mid-backfill, or the rollup job never ran), the report
 * falls back to the pure-raw path, so results are byte-identical either way.
 * The per-query reports are unaffected: the rollup stores no query text.
 */
function utcDayStr(d: Date): string { return d.toISOString().slice(0, 10); }
function addDayStr(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return utcDayStr(d);
}
/** Split a window into its completed-day sub-window and whether "today" is in it. */
function splitWindow(w: DateWindow, now: Date): { completed: DateWindow | null; today: string | null } {
  const today = utcDayStr(now);
  const yesterday = addDayStr(today, -1);
  const completedTo = w.toDay < yesterday ? w.toDay : yesterday; // min(toDay, yesterday)
  const completed = w.fromDay <= completedTo ? { fromDay: w.fromDay, toDay: completedTo } : null;
  const today_ = w.toDay >= today && w.fromDay <= today ? today : null;
  return { completed, today: today_ };
}

interface SummaryCounts { searches: number; zero: number; clicks: number; atc: number; redirects: number }
const ZERO_COUNTS: SummaryCounts = { searches: 0, zero: 0, clicks: 0, atc: 0, redirects: 0 };
function addCounts(a: SummaryCounts, b: SummaryCounts): SummaryCounts {
  return { searches: a.searches + b.searches, zero: a.zero + b.zero, clicks: a.clicks + b.clicks, atc: a.atc + b.atc, redirects: a.redirects + b.redirects };
}

/** Raw per-event_type counts over a window (the original summary aggregate). */
async function rawSummaryCounts(exec: Exec, shopId: string, w: DateWindow): Promise<SummaryCounts> {
  const pb = new Params(); const sid = pb.add(shopId); const win = windowPredicate(pb, w); const clicks = pb.add(CLICK_TYPES);
  const rows = await exec.rows<{ searches: number; zero: number; clicks: number; atc: number; redirects: number }>(
    `SELECT
       count(*) FILTER (WHERE event_type='search_performed')::int AS searches,
       count(*) FILTER (WHERE event_type='search_zero_result')::int AS zero,
       count(*) FILTER (WHERE event_type = ANY(${clicks}::text[]))::int AS clicks,
       count(*) FILTER (WHERE event_type='add_to_cart_from_search')::int AS atc,
       count(*) FILTER (WHERE event_type='redirect_followed')::int AS redirects
     FROM analytics_event WHERE shop_id=${sid}::uuid AND ${win}`,
    pb.values,
  );
  const r = rows[0] ?? ZERO_COUNTS;
  return { searches: Number(r.searches), zero: Number(r.zero), clicks: Number(r.clicks), atc: Number(r.atc), redirects: Number(r.redirects) };
}

/** Rollup per-event_type counts over a COMPLETED-day window (day-keyed). */
async function rollupSummaryCounts(exec: Exec, shopId: string, w: DateWindow): Promise<SummaryCounts> {
  const pb = new Params(); const sid = pb.add(shopId); const f = pb.add(w.fromDay); const t = pb.add(w.toDay); const clicks = pb.add(CLICK_TYPES);
  const rows = await exec.rows<{ searches: number; zero: number; clicks: number; atc: number; redirects: number }>(
    `SELECT
       coalesce(sum(event_count) FILTER (WHERE event_type='search_performed'),0)::int AS searches,
       coalesce(sum(event_count) FILTER (WHERE event_type='search_zero_result'),0)::int AS zero,
       coalesce(sum(event_count) FILTER (WHERE event_type = ANY(${clicks}::text[])),0)::int AS clicks,
       coalesce(sum(event_count) FILTER (WHERE event_type='add_to_cart_from_search'),0)::int AS atc,
       coalesce(sum(event_count) FILTER (WHERE event_type='redirect_followed'),0)::int AS redirects
     FROM analytics_rollup_daily
     WHERE shop_id=${sid}::uuid AND day >= ${f}::date AND day <= ${t}::date`,
    pb.values,
  );
  const r = rows[0] ?? ZERO_COUNTS;
  return { searches: Number(r.searches), zero: Number(r.zero), clicks: Number(r.clicks), atc: Number(r.atc), redirects: Number(r.redirects) };
}

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
  exec: Exec, shopId: string, w: DateWindow, now: Date = new Date(),
): Promise<SummaryReport> {
  const { completed, today } = splitWindow(w, now);
  // Long-range windows read the rollup for the completed portion when it fully
  // encloses it; short windows and any uncovered window take the single raw
  // aggregate over the whole window (byte-identical, unchanged query shape).
  const longRange = !!completed && daysInclusive(completed.fromDay, completed.toDay) > ROLLUP_MIN_WINDOW_DAYS;
  let counts: SummaryCounts;
  if (longRange && (await rollupCoverage(exec, shopId, completed!.fromDay, completed!.toDay)).covered) {
    counts = await rollupSummaryCounts(exec, shopId, completed!);
    if (today) counts = addCounts(counts, await rawSummaryCounts(exec, shopId, { fromDay: today, toDay: today }));
  } else {
    counts = await rawSummaryCounts(exec, shopId, w);
  }
  const searches = counts.searches;
  const ratio = (num: number) => (searches > 0 ? num / searches : 0);
  return {
    window: w,
    searches,
    zeroResults: counts.zero,
    zeroResultRate: ratio(counts.zero),
    clicks: counts.clicks,
    clickThroughRate: ratio(counts.clicks),
    addToCartFromSearch: counts.atc,
    addToCartRate: ratio(counts.atc),
    redirects: counts.redirects,
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
export async function perSurface(exec: Exec, shopId: string, w: DateWindow, now: Date = new Date()): Promise<SurfaceRow[]> {
  const rawSurface = async (win: DateWindow): Promise<SurfaceRow[]> => {
    const pb = new Params(); const sid = pb.add(shopId); const wp = windowPredicate(pb, win);
    return exec.rows<SurfaceRow>(
      `SELECT surface, count(*)::int AS events FROM analytics_event
       WHERE shop_id=${sid}::uuid AND ${wp} GROUP BY surface`, pb.values);
  };
  const { completed, today } = splitWindow(w, now);
  const longRange = !!completed && daysInclusive(completed.fromDay, completed.toDay) > ROLLUP_MIN_WINDOW_DAYS;
  if (!longRange || !(await rollupCoverage(exec, shopId, completed!.fromDay, completed!.toDay)).covered) {
    // pure raw, original ordering
    const pb = new Params(); const sid = pb.add(shopId); const wp = windowPredicate(pb, w);
    return exec.rows<SurfaceRow>(
      `SELECT surface, count(*)::int AS events FROM analytics_event
       WHERE shop_id=${sid}::uuid AND ${wp} GROUP BY surface ORDER BY events DESC, surface ASC`, pb.values);
  }
  const agg = new Map<string, number>();
  if (completed) {
    const pb = new Params(); const sid = pb.add(shopId); const f = pb.add(completed.fromDay); const t = pb.add(completed.toDay);
    const rows = await exec.rows<SurfaceRow>(
      `SELECT surface, sum(event_count)::int AS events FROM analytics_rollup_daily
       WHERE shop_id=${sid}::uuid AND day >= ${f}::date AND day <= ${t}::date GROUP BY surface`, pb.values);
    for (const r of rows) agg.set(r.surface, (agg.get(r.surface) ?? 0) + Number(r.events));
  }
  if (today) for (const r of await rawSurface({ fromDay: today, toDay: today })) agg.set(r.surface, (agg.get(r.surface) ?? 0) + Number(r.events));
  return [...agg.entries()].map(([surface, events]) => ({ surface, events }))
    .sort((a, b) => b.events - a.events || (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0));
}

export interface TrendRow { day: string; searches: number; clicks: number; zeroResults: number; addToCart: number }
export async function dailyTrend(exec: Exec, shopId: string, w: DateWindow, now: Date = new Date()): Promise<TrendRow[]> {
  const rawTrend = async (win: DateWindow): Promise<TrendRow[]> => {
    const pb = new Params(); const sid = pb.add(shopId); const wp = windowPredicate(pb, win); const clicks = pb.add(CLICK_TYPES);
    return exec.rows<TrendRow>(
      `SELECT to_char((occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
         count(*) FILTER (WHERE event_type='search_performed')::int AS searches,
         count(*) FILTER (WHERE event_type = ANY(${clicks}::text[]))::int AS clicks,
         count(*) FILTER (WHERE event_type='search_zero_result')::int AS "zeroResults",
         count(*) FILTER (WHERE event_type='add_to_cart_from_search')::int AS "addToCart"
       FROM analytics_event WHERE shop_id=${sid}::uuid AND ${wp}
       GROUP BY 1 ORDER BY 1 ASC`, pb.values);
  };
  const { completed, today } = splitWindow(w, now);
  const longRange = !!completed && daysInclusive(completed.fromDay, completed.toDay) > ROLLUP_MIN_WINDOW_DAYS;
  if (!longRange || !(await rollupCoverage(exec, shopId, completed!.fromDay, completed!.toDay)).covered) return rawTrend(w);

  const out: TrendRow[] = [];
  if (completed) {
    const pb = new Params(); const sid = pb.add(shopId); const f = pb.add(completed.fromDay); const t = pb.add(completed.toDay); const clicks = pb.add(CLICK_TYPES);
    const rows = await exec.rows<TrendRow>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day,
         coalesce(sum(event_count) FILTER (WHERE event_type='search_performed'),0)::int AS searches,
         coalesce(sum(event_count) FILTER (WHERE event_type = ANY(${clicks}::text[])),0)::int AS clicks,
         coalesce(sum(event_count) FILTER (WHERE event_type='search_zero_result'),0)::int AS "zeroResults",
         coalesce(sum(event_count) FILTER (WHERE event_type='add_to_cart_from_search'),0)::int AS "addToCart"
       FROM analytics_rollup_daily WHERE shop_id=${sid}::uuid AND day >= ${f}::date AND day <= ${t}::date
       GROUP BY day`, pb.values);
    for (const r of rows) out.push({ day: r.day, searches: Number(r.searches), clicks: Number(r.clicks), zeroResults: Number(r.zeroResults), addToCart: Number(r.addToCart) });
  }
  if (today) for (const r of await rawTrend({ fromDay: today, toDay: today })) out.push(r);
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
