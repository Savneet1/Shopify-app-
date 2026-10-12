import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { isUuid } from "~/lib/merch/assign";

/**
 * Phase 10.6 — aggregate bundle metrics (views + add-to-cart clicks), per UTC
 * day, per bundle. Fed by a PUBLIC App Proxy beacon with the same hardening as
 * the Phase 8/9 beacons:
 *   - the bundle id is validated with isUuid BEFORE any SQL (junk dropped, never
 *     cast); the type is a strict allow-list;
 *   - the bundle must exist for THIS shop (checked under RLS) so a foreign/other
 *     -shop id is a no-op, not a mis-attributed counter;
 *   - only a bounded aggregate counter is incremented — NO visitor id, NO IP, NO
 *     per-user row, NO query text, NO logging;
 *   - recordBundleSignal never throws / never 500s (returns a boolean).
 *
 * The beacon is PUBLIC and inflatable, so the counts are ADVISORY only — Phase 11
 * analytics supersedes. The admin shows them with an explicit "advisory" note.
 *
 * WINDOW + RETENTION: the admin aggregates the last BUNDLE_WINDOW_DAYS; rows
 * older than RETENTION_DAYS (≥ window) are purged by the existing maintenance
 * tick (see app/lib/jobs/maintenance.ts, which calls purgeOldBundleSignals in
 * the same per-shop retention pass as product signals).
 */

export const BUNDLE_WINDOW_DAYS = 30;
export const BUNDLE_RETENTION_DAYS = 120;
export const BUNDLE_PURGE_BATCH_SIZE = 10000;

export type BundleSignalType = "view" | "add_to_cart";

export async function recordBundleSignal(
  exec: Exec,
  shopId: string,
  rawBundleId: unknown,
  rawType: unknown,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    if (!isUuid(rawBundleId)) return false;
    const type = rawType === "view" || rawType === "add_to_cart" ? (rawType as BundleSignalType) : null;
    if (!type) return false;
    const bundleId = String(rawBundleId);
    // Bundle must belong to THIS shop (RLS-scoped select) → foreign id is a no-op.
    const exists = await exec.rows<{ id: string }>(
      `SELECT id FROM bundle WHERE shop_id=$1::uuid AND id=$2::uuid`,
      [shopId, bundleId],
    );
    if (!exists[0]) return false;
    const col = type === "add_to_cart" ? "add_to_cart_clicks" : "views";
    const pb = new Params();
    const sid = pb.add(shopId);
    const bid = pb.add(bundleId);
    const ts = pb.add(now.toISOString());
    await exec.run(
      `INSERT INTO bundle_signal_daily (shop_id, bundle_id, day, ${col}, updated_at)
       VALUES (${sid}::uuid, ${bid}::uuid, ((${ts}::timestamptz) AT TIME ZONE 'UTC')::date, 1, now())
       ON CONFLICT (shop_id, bundle_id, day)
       DO UPDATE SET ${col} = bundle_signal_daily.${col} + 1, updated_at = now()`,
      pb.values,
    );
    return true;
  } catch {
    return false;
  }
}

export interface BundleSignalSummaryRow {
  bundle_id: string;
  views: number;
  add_to_cart_clicks: number;
}

/** Per-bundle views/clicks aggregated over the trailing window (advisory). */
export async function bundleSignalSummary(
  exec: Exec, shopId: string, opts: { windowDays?: number; now?: Date } = {},
): Promise<BundleSignalSummaryRow[]> {
  const windowDays = Math.max(1, Math.min(365, Math.floor(opts.windowDays ?? BUNDLE_WINDOW_DAYS)));
  const now = opts.now ?? new Date();
  const pb = new Params();
  const sid = pb.add(shopId);
  const pNow = pb.add(now.toISOString());
  const pWindow = pb.add(windowDays);
  return exec.rows<BundleSignalSummaryRow>(
    `SELECT bundle_id,
            COALESCE(SUM(views),0)::int AS views,
            COALESCE(SUM(add_to_cart_clicks),0)::int AS add_to_cart_clicks
     FROM bundle_signal_daily
     WHERE shop_id=${sid}::uuid
       AND day >= ((((${pNow}::timestamptz) AT TIME ZONE 'UTC')::date) - ${pWindow}::int)
     GROUP BY bundle_id`,
    pb.values,
  );
}

/**
 * Delete bundle_signal_daily rows older than retentionDays for ONE shop, under
 * the caller's tenant transaction (RLS). Bounded to batchSize rows/call (short
 * locks); idempotent; drains over successive ticks. Mirrors the product-signal
 * purge (Phase 9.1 K2).
 */
export async function purgeOldBundleSignals(
  exec: Exec,
  shopId: string,
  opts: { retentionDays?: number; batchSize?: number; now?: Date } = {},
): Promise<number> {
  const retentionDays = Math.max(1, Math.floor(opts.retentionDays ?? BUNDLE_RETENTION_DAYS));
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? BUNDLE_PURGE_BATCH_SIZE));
  const now = opts.now ?? new Date();
  const pb = new Params();
  const pShop = pb.add(shopId);
  const pNow = pb.add(now.toISOString());
  const pRet = pb.add(retentionDays);
  const pBatch = pb.add(batchSize);
  return exec.run(
    `DELETE FROM bundle_signal_daily
     WHERE (shop_id, bundle_id, day) IN (
       SELECT shop_id, bundle_id, day FROM bundle_signal_daily
       WHERE shop_id = ${pShop}::uuid
         AND day < ((((${pNow}::timestamptz) AT TIME ZONE 'UTC')::date) - ${pRet}::int)
       ORDER BY day ASC
       LIMIT ${pBatch}::int
     )`,
    pb.values,
  );
}
