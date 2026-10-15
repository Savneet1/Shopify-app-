import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import {
  loadAnalyticsSettings, PARTITION_RETENTION_DAYS, ROLLUP_RETENTION_DAYS,
} from "./settings";

/**
 * Phase 11 retention + partition maintenance. Runs from the EXISTING
 * maintenance tick (same bounded-batch discipline as the Phase 9.1/10 signal
 * retention). Three jobs:
 *   1. per-shop ROW purge of analytics_event older than that shop's
 *      configurable retention_days (RLS-scoped, bounded batch per run);
 *   2. per-shop ROW purge of analytics_rollup_daily older than ROLLUP_RETENTION;
 *   3. a global PARTITION job (owner definer): ensure current+next2 months
 *      exist, drop partitions older than the HARD cap (PARTITION_RETENTION_DAYS).
 */

export const ANALYTICS_PURGE_BATCH_SIZE = 10000;

/** Per-shop purge of analytics_event rows older than the shop's retention. */
export async function purgeOldAnalyticsEvents(
  exec: Exec, shopId: string, opts: { batchSize?: number; now?: Date } = {},
): Promise<number> {
  const { retentionDays } = await loadAnalyticsSettings(exec, shopId);
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? ANALYTICS_PURGE_BATCH_SIZE));
  const now = opts.now ?? new Date();
  const pb = new Params();
  const sid = pb.add(shopId);
  const pNow = pb.add(now.toISOString());
  const pRet = pb.add(retentionDays);
  const pBatch = pb.add(batchSize);
  // Bounded delete via a PK (occurred_at, id) subquery. RLS already scopes to
  // the shop; the explicit shop_id keeps the predicate sargable.
  return exec.run(
    `DELETE FROM analytics_event
     WHERE (occurred_at, id) IN (
       SELECT occurred_at, id FROM analytics_event
       WHERE shop_id = ${sid}::uuid
         AND occurred_at < (${pNow}::timestamptz - make_interval(days => ${pRet}::int))
       ORDER BY occurred_at ASC
       LIMIT ${pBatch}::int
     )`,
    pb.values,
  );
}

/** Per-shop purge of rollup rows older than the rollup retention cap. */
export async function purgeOldAnalyticsRollup(
  exec: Exec, shopId: string, opts: { batchSize?: number; now?: Date } = {},
): Promise<number> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? ANALYTICS_PURGE_BATCH_SIZE));
  const now = opts.now ?? new Date();
  const pb = new Params();
  const sid = pb.add(shopId);
  const pNow = pb.add(now.toISOString());
  const pBatch = pb.add(batchSize);
  return exec.run(
    `DELETE FROM analytics_rollup_daily
     WHERE (day) IN (
       SELECT day FROM analytics_rollup_daily
       WHERE shop_id = ${sid}::uuid
         AND day < ((((${pNow}::timestamptz) AT TIME ZONE 'UTC')::date) - ${ROLLUP_RETENTION_DAYS}::int)
       ORDER BY day ASC
       LIMIT ${pBatch}::int
     )`,
    pb.values,
  );
}

export interface PartitionMaintenanceResult {
  ensured: string[];
  dropped: number;
}

/** Partition name for a date's UTC month — the SAME `YYYY_MM` the SQL function
 * derives via to_char(date_trunc('month', ts), 'YYYY_MM'). Pure. */
export function analyticsMonthName(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `analytics_event_${y}_${m}`;
}

/** The month targets (date + partition name) to ensure for a given `now`.
 * Default offsets = current + next 2 months. Pure; handles Dec→Jan year
 * rollover and leap Februaries via UTC Date arithmetic. */
export function analyticsMonthTargets(
  now: Date, offsets: number[] = [0, 1, 2],
): { date: Date; name: string }[] {
  return offsets.map((k) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1, 12, 0, 0));
    return { date, name: analyticsMonthName(date) };
  });
}

/**
 * Global partition maintenance (owner-owned definer functions; runs on the
 * root/owner path of the tick, NOT per shop). Ensures the current + next 2
 * months exist and drops partitions entirely older than the hard cap. The DB
 * `app_ensure_analytics_partition` only accepts months within its real-clock
 * range [now-14, now+3], so `now` must be the (real) server clock in production.
 */
export async function maintainAnalyticsPartitions(
  rootExec: Exec, opts: { now?: Date } = {},
): Promise<PartitionMaintenanceResult> {
  const now = opts.now ?? new Date();
  const ensured: string[] = [];
  for (const { date } of analyticsMonthTargets(now)) {
    const rows = await rootExec.rows<{ app_ensure_analytics_partition: string }>(
      `SELECT app_ensure_analytics_partition($1::timestamptz)`,
      [date.toISOString()],
    );
    if (rows[0]) ensured.push(rows[0].app_ensure_analytics_partition);
  }
  const cutoff = new Date(now.getTime() - PARTITION_RETENTION_DAYS * 86400_000);
  const dropRows = await rootExec.rows<{ app_drop_analytics_partitions_before: number }>(
    `SELECT app_drop_analytics_partitions_before($1::timestamptz)`,
    [cutoff.toISOString()],
  );
  return { ensured, dropped: Number(dropRows[0]?.app_drop_analytics_partitions_before ?? 0) };
}

/** List current analytics partition names (for the tick log + tests). */
export async function listAnalyticsPartitions(rootExec: Exec): Promise<string[]> {
  const rows = await rootExec.rows<{ partition_name: string }>(
    `SELECT partition_name FROM app_list_analytics_partitions()`,
  );
  return rows.map((r) => r.partition_name);
}
