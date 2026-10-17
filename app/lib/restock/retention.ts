import type { Exec } from "~/lib/db/executor";
import { loadRestockSettings, UNCONFIRMED_TTL_DAYS } from "./settings";

/**
 * Phase 12.7 — per-shop back-in-stock retention, in bounded batches, RLS-scoped.
 *
 *  (a) unconfirmed (pending) double-opt-in rows are purged after 7 days — an
 *      unconfirmed address is never mailed an alert and must not linger;
 *  (b) notified / unsubscribed / bounced rows older than the configured window
 *      (<= 90 days) are reduced to a minimal HASHED-EMAIL suppression record so
 *      the address is never re-mailed, then the subscription row (with its
 *      plaintext email) is deleted;
 *  (c) terminal / orphaned notification-ledger rows older than the window are
 *      removed (incl. long-pending rows for shops that never configured email).
 */

export const PENDING_NOTIFICATION_TTL_DAYS = 30;
export const DEFAULT_RESTOCK_BATCH = 5000;

export interface RestockMaintenanceResult {
  unconfirmedPurged: number;
  reducedToSuppression: number;
  notificationsPurged: number;
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86400_000).toISOString();
}

export async function purgeRestockData(
  exec: Exec, shopId: string, opts: { now?: Date; batchSize?: number } = {},
): Promise<RestockMaintenanceResult> {
  const now = opts.now ?? new Date();
  const batch = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_RESTOCK_BATCH));
  const settings = await loadRestockSettings(exec, shopId);

  // (a) purge unconfirmed rows older than the 7-day confirm window.
  const unconfirmedCutoff = daysAgo(now, UNCONFIRMED_TTL_DAYS);
  const unconfirmedPurged = await exec.run(
    `DELETE FROM back_in_stock_subscription
     WHERE id IN (
       SELECT id FROM back_in_stock_subscription
       WHERE shop_id=$1::uuid AND status='pending' AND created_at < $2::timestamptz
       ORDER BY created_at ASC LIMIT $3::int
     )`,
    [shopId, unconfirmedCutoff, batch],
  );

  // (b) reduce old terminal rows to a suppression record, then delete them.
  const retentionCutoff = daysAgo(now, settings.notifiedRetentionDays);
  await exec.run(
    `INSERT INTO restock_suppression (shop_id, email_hash, reason, created_at)
     SELECT shop_id, email_hash, 'retention', now()
     FROM back_in_stock_subscription
     WHERE shop_id=$1::uuid AND status IN ('notified','unsubscribed','bounced') AND updated_at < $2::timestamptz
     ON CONFLICT (shop_id, email_hash) DO NOTHING`,
    [shopId, retentionCutoff],
  );
  const reducedToSuppression = await exec.run(
    `DELETE FROM back_in_stock_subscription
     WHERE id IN (
       SELECT id FROM back_in_stock_subscription
       WHERE shop_id=$1::uuid AND status IN ('notified','unsubscribed','bounced') AND updated_at < $2::timestamptz
       ORDER BY updated_at ASC LIMIT $3::int
     )`,
    [shopId, retentionCutoff, batch],
  );

  // (c) clean up old notification-ledger rows (terminal, or long-pending).
  const notifCutoff = daysAgo(now, PENDING_NOTIFICATION_TTL_DAYS);
  const notificationsPurged = await exec.run(
    `DELETE FROM restock_notification
     WHERE id IN (
       SELECT id FROM restock_notification
       WHERE shop_id=$1::uuid AND created_at < $2::timestamptz
       ORDER BY created_at ASC LIMIT $3::int
     )`,
    [shopId, notifCutoff, batch],
  );

  return { unconfirmedPurged, reducedToSuppression, notificationsPurged };
}
