import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { ROLLUP_RETENTION_DAYS } from "./settings";

/**
 * Phase 14.6c — bounded daily rollup of analytics_event into
 * analytics_rollup_daily (shop_id, day, event_type, surface, event_count).
 *
 * WHY: the 90-day report queries aggregate the full window of raw events every
 * time. Measured at 100k events/day (9M rows) the summary took ~2 s and the
 * trend/top-queries ~4.5 s on the bench node — past a sensible interactive
 * bound (see docs/PHASE14.md). The rollup pre-aggregates COMPLETED days so the
 * event_type/surface reports (summary, daily trend, per-surface) read a few
 * thousand rollup rows instead of millions of raw rows. By design the rollup
 * stores NO query text (migration 0013), so the per-query reports
 * (topQueries/zeroResult/noClicks) deliberately stay on raw.
 *
 * CORRECTNESS: only days strictly before "today" (UTC) are rolled up. A
 * completed day is immutable (occurred_at is the server clock at ingest, never
 * backdated), so a completed-day rollup equals the raw aggregate for that day
 * exactly — the reports' rollup path is byte-identical to the raw path (proven
 * by test). The current (partial) day is always read from raw.
 *
 * BOUNDED + CONVERGING: each run re-rolls the most recent REFRESH_DAYS completed
 * days (to finalise a day that was partial when last rolled) and extends the
 * rolled range backwards by up to BACKFILL_DAYS older days, until the rolled
 * range reaches the retention floor. Each run therefore scans at most
 * (REFRESH_DAYS + BACKFILL_DAYS) days of raw events for the shop — never the
 * whole window — using the (shop_id, occurred_at) index. Idempotent: a day is
 * DELETEd then re-INSERTed, so re-running is safe and self-correcting.
 */

export const ROLLUP_REFRESH_DAYS = 2;    // always re-roll the N most recent completed days
export const ROLLUP_BACKFILL_DAYS = 14;  // extend the rolled range back by up to N days per run

/**
 * The rollup read path activates only for LONG-RANGE report windows whose
 * completed portion spans more than this many days. Short windows (e.g. the
 * 30-day dashboard default) read raw directly — they are cheap on raw and this
 * keeps their query shape/count unchanged. 45 sits between the 30-day default
 * and the 90-day long-range reports the rollup is for.
 */
export const ROLLUP_MIN_WINDOW_DAYS = 45;

/** Inclusive day span between two YYYY-MM-DD dates (UTC). */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;
}

/** UTC midnight date (YYYY-MM-DD) for a Date. */
function utcDay(d: Date): string { return d.toISOString().slice(0, 10); }
/** Add whole days to a YYYY-MM-DD date string (UTC), returning YYYY-MM-DD. */
function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return utcDay(d);
}

export interface RollupResult { refreshedFrom: string; refreshedTo: string; backfilledFrom: string | null; backfilledTo: string | null; }

/**
 * Roll up completed days for one shop. RLS-scoped (run under withShop). Returns
 * the day ranges touched (half-open [from, to), i.e. `to` is exclusive).
 */
export async function rollupAnalyticsDaily(
  exec: Exec, shopId: string,
  opts: { now?: Date; retentionDays?: number; refreshDays?: number; backfillDays?: number } = {},
): Promise<RollupResult> {
  const now = opts.now ?? new Date();
  const retention = Math.max(1, Math.floor(opts.retentionDays ?? ROLLUP_RETENTION_DAYS));
  const refreshDays = Math.max(1, Math.floor(opts.refreshDays ?? ROLLUP_REFRESH_DAYS));
  const backfillDays = Math.max(0, Math.floor(opts.backfillDays ?? ROLLUP_BACKFILL_DAYS));

  const today = utcDay(now);                 // partial day — never rolled
  const windowStart = addDays(today, -retention); // retention floor (inclusive)

  // 1) Refresh the most recent completed days: [max(windowStart, today-refresh), today).
  const refreshFrom = (() => { const f = addDays(today, -refreshDays); return f < windowStart ? windowStart : f; })();
  await rollDayRange(exec, shopId, refreshFrom, today);

  // 2) Backfill older days by extending the rolled range backwards.
  const minRolled = await rolledMinDay(exec, shopId);
  // The oldest day we still need is windowStart; stop once the range reaches it.
  const backfillTo = minRolled && minRolled < refreshFrom ? minRolled : refreshFrom; // exclusive upper
  let backfilledFrom: string | null = null, backfilledTo: string | null = null;
  if (backfillDays > 0 && backfillTo > windowStart) {
    const from = (() => { const f = addDays(backfillTo, -backfillDays); return f < windowStart ? windowStart : f; })();
    if (from < backfillTo) { await rollDayRange(exec, shopId, from, backfillTo); backfilledFrom = from; backfilledTo = backfillTo; }
  }
  return { refreshedFrom: refreshFrom, refreshedTo: today, backfilledFrom, backfilledTo };
}

/** DELETE then re-INSERT the per-(day,event_type,surface) counts for [from, to). */
async function rollDayRange(exec: Exec, shopId: string, from: string, to: string): Promise<void> {
  if (!(from < to)) return;
  {
    const pb = new Params(); const sid = pb.add(shopId); const f = pb.add(from); const t = pb.add(to);
    await exec.run(
      `DELETE FROM analytics_rollup_daily
       WHERE shop_id=${sid}::uuid AND day >= ${f}::date AND day < ${t}::date`,
      pb.values,
    );
  }
  {
    const pb = new Params(); const sid = pb.add(shopId); const f = pb.add(from); const t = pb.add(to);
    // Range predicate on occurred_at is sargable (uses analytics_event_shop_time_idx);
    // the day is derived once per row. Only completed days (to <= today) reach here.
    await exec.run(
      `INSERT INTO analytics_rollup_daily (shop_id, day, event_type, surface, event_count, updated_at)
       SELECT ${sid}::uuid,
              (occurred_at AT TIME ZONE 'UTC')::date AS day,
              event_type, surface, count(*)::bigint, now()
       FROM analytics_event
       WHERE shop_id=${sid}::uuid
         AND occurred_at >= ${f}::date AND occurred_at < ${t}::date
       GROUP BY 2, 3, 4`,
      pb.values,
    );
  }
}

async function rolledMinDay(exec: Exec, shopId: string): Promise<string | null> {
  const pb = new Params(); const sid = pb.add(shopId);
  const rows = await exec.rows<{ d: string | null }>(
    `SELECT to_char(min(day), 'YYYY-MM-DD') AS d FROM analytics_rollup_daily WHERE shop_id=${sid}::uuid`,
    pb.values,
  );
  return rows[0]?.d ?? null;
}

/**
 * Coverage of the COMPLETED-day portion of a window by the rollup. Returns the
 * rolled range [min, max] (inclusive) and whether it encloses [from, completedTo].
 * Because the writer rolls WHOLE days, an enclosed range guarantees every
 * completed in-window day that had events is present (a zero-event day correctly
 * has no rollup row and no raw row). Cheap: indexed min/max only.
 */
export async function rollupCoverage(
  exec: Exec, shopId: string, from: string, completedTo: string,
): Promise<{ covered: boolean; minDay: string | null; maxDay: string | null }> {
  const pb = new Params(); const sid = pb.add(shopId);
  const rows = await exec.rows<{ mn: string | null; mx: string | null }>(
    `SELECT to_char(min(day),'YYYY-MM-DD') AS mn, to_char(max(day),'YYYY-MM-DD') AS mx
     FROM analytics_rollup_daily WHERE shop_id=${sid}::uuid`,
    pb.values,
  );
  const minDay = rows[0]?.mn ?? null, maxDay = rows[0]?.mx ?? null;
  // completedTo < from means the window has no completed days (e.g. a today-only
  // window): trivially "covered" (nothing to read from the rollup).
  const covered = completedTo < from ? true : !!(minDay && maxDay && minDay <= from && maxDay >= completedTo);
  return { covered, minDay, maxDay };
}
