import type { Exec } from "~/lib/db/executor";
import { purgeOldSignals, RETENTION_DAYS, PURGE_BATCH_SIZE } from "~/lib/recommend/signals";
import { purgeOldBundleSignals } from "~/lib/bundles/signals";
import {
  purgeOldAnalyticsEvents, purgeOldAnalyticsRollup, maintainAnalyticsPartitions,
  type PartitionMaintenanceResult,
} from "~/lib/analytics/retention";
import { purgeRestockData, selectStrandedConfirmations, type RestockMaintenanceResult } from "~/lib/restock/retention";

/**
 * Scheduled reconciliation (G8). A periodic tick enumerates INSTALLED shops
 * whose last full sync is older than `interval` (or never) via the SECURITY
 * DEFINER function app_shops_needing_full_sync(), and enqueues a full sync for
 * each. This is a safety net for missed webhooks / drift; per-shop
 * serialization (stately policy + DB running-guard) prevents pile-ups.
 */
export async function selectShopsNeedingFullSync(
  exec: Exec,
  interval: string,
): Promise<string[]> {
  const rows = await exec.rows<{ id: string }>(
    `SELECT id FROM app_shops_needing_full_sync($1::interval)`,
    [interval],
  );
  return rows.map((r) => r.id);
}

export async function runReconciliationTick(
  exec: Exec,
  enqueue: (shopId: string) => Promise<unknown>,
  interval: string,
): Promise<number> {
  const ids = await selectShopsNeedingFullSync(exec, interval);
  for (const id of ids) await enqueue(id);
  return ids.length;
}

/**
 * Enumerate every INSTALLED shop id. Reuses the existing SECURITY DEFINER
 * enumerator with a zero interval (every installed shop's last full sync is in
 * the past, or null), so retention covers ACTIVELY-synced shops too — not just
 * the stale ones the reconciliation tick enqueues. Only shop ids are exposed.
 */
export async function selectInstalledShops(exec: Exec): Promise<string[]> {
  const rows = await exec.rows<{ id: string }>(
    `SELECT id FROM app_shops_needing_full_sync('0 seconds'::interval)`,
  );
  return rows.map((r) => r.id);
}

/**
 * K2 — signal-retention pass. For each installed shop, delete one bounded batch
 * of product_signal_daily rows older than RETENTION_DAYS, under that shop's
 * tenant context (RLS). Runs from the SAME periodic maintenance tick as
 * reconciliation (no new queue). Bounded per shop per run so locks stay short;
 * a large backlog drains over successive ticks. Returns rows deleted this run.
 */
export async function runSignalRetention(
  rootExec: Exec,
  runner: <T>(shopId: string, fn: (exec: Exec) => Promise<T>) => Promise<T>,
  opts: { retentionDays?: number; batchSize?: number; now?: Date } = {},
): Promise<number> {
  const ids = await selectInstalledShops(rootExec);
  let deleted = 0;
  for (const id of ids) {
    deleted += await runner(id, async (e) => {
      // Product trending signals (Phase 9.1), bundle signals (Phase 10.6) and
      // analytics events/rollup (Phase 11) share this per-shop retention pass —
      // same bounded-batch discipline, all RLS-scoped to the shop.
      const a = await purgeOldSignals(e, id, {
        retentionDays: opts.retentionDays ?? RETENTION_DAYS,
        batchSize: opts.batchSize ?? PURGE_BATCH_SIZE,
        now: opts.now,
      });
      const b = await purgeOldBundleSignals(e, id, { now: opts.now });
      const c = await purgeOldAnalyticsEvents(e, id, { now: opts.now });
      const d = await purgeOldAnalyticsRollup(e, id, { now: opts.now });
      return a + b + c + d;
    });
  }
  return deleted;
}

/**
 * Phase 11 — global analytics partition maintenance. Runs on the root/owner
 * path of the tick (NOT per shop): ensure current + next 2 months exist, drop
 * partitions older than the hard cap. Reuses the owner-owned definer functions.
 */
export async function runAnalyticsPartitionMaintenance(
  rootExec: Exec, opts: { now?: Date } = {},
): Promise<PartitionMaintenanceResult> {
  return maintainAnalyticsPartitions(rootExec, opts);
}

/**
 * Phase 12.7 — back-in-stock retention. For each installed shop (RLS-scoped,
 * bounded batches): purge unconfirmed opt-ins after 7 days; reduce old
 * notified/unsubscribed/bounced rows to a minimal hashed-email suppression
 * record; clean up terminal/old notification-ledger rows. Runs on the SAME
 * maintenance tick as the other retention passes (no new queue).
 */
export async function runRestockMaintenance(
  rootExec: Exec,
  runner: <T>(shopId: string, fn: (exec: Exec) => Promise<T>) => Promise<T>,
  opts: { now?: Date; batchSize?: number } = {},
): Promise<RestockMaintenanceResult> {
  const ids = await selectInstalledShops(rootExec);
  const agg: RestockMaintenanceResult = { unconfirmedPurged: 0, reducedToSuppression: 0, notificationsPurged: 0 };
  for (const id of ids) {
    const r = await runner(id, (e) => purgeRestockData(e, id, opts));
    agg.unconfirmedPurged += r.unconfirmedPurged;
    agg.reducedToSuppression += r.reducedToSuppression;
    agg.notificationsPurged += r.notificationsPurged;
  }
  return agg;
}

/**
 * Phase 12.2 R5b — re-enqueue stranded double-opt-in confirmations (the enqueue
 * failed or the process died after the subscription committed). For each
 * installed shop (RLS-scoped, bounded batch) it selects pending rows with no
 * confirmation sent and re-enqueues them with the SAME singleton key, so a
 * re-run never duplicates a job. Returns how many were re-enqueued.
 */
export async function runRestockConfirmSweep(
  rootExec: Exec,
  runner: <T>(shopId: string, fn: (exec: Exec) => Promise<T>) => Promise<T>,
  enqueue: (shopId: string, subscriptionId: string) => Promise<unknown>,
  opts: { now?: Date; batchSize?: number } = {},
): Promise<number> {
  const ids = await selectInstalledShops(rootExec);
  let total = 0;
  for (const id of ids) {
    const stranded = await runner(id, (e) => selectStrandedConfirmations(e, id, opts));
    for (const subId of stranded) { await enqueue(id, subId).catch(() => {}); total++; }
  }
  return total;
}
