import type { Exec } from "~/lib/db/executor";
import { purgeOldSignals, RETENTION_DAYS, PURGE_BATCH_SIZE } from "~/lib/recommend/signals";

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
    deleted += await runner(id, (e) =>
      purgeOldSignals(e, id, {
        retentionDays: opts.retentionDays ?? RETENTION_DAYS,
        batchSize: opts.batchSize ?? PURGE_BATCH_SIZE,
        now: opts.now,
      }),
    );
  }
  return deleted;
}
