import type { Exec } from "~/lib/db/executor";

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
