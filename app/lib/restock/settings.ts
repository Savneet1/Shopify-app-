import type { Exec } from "~/lib/db/executor";

/**
 * Phase 12.6 — per-shop restock caps + retention windows. Defaults are chosen
 * so the public endpoint cannot be used to spam a third party or flood storage,
 * and so notified/unsubscribed rows are reduced to a minimal suppression record
 * within a bounded window.
 */

export const RESTOCK_DEFAULTS = {
  perEmailDailyCap: 10,
  perShopDailyCap: 5000,
  sendRatePerRun: 100,
  notifiedRetentionDays: 30, // <= 90 (documented)
} as const;

/** Unconfirmed (pending) double-opt-in rows are purged after this many days. */
export const UNCONFIRMED_TTL_DAYS = 7;
/** Hard upper bound on the configurable notified/unsubscribed retention. */
export const MAX_NOTIFIED_RETENTION_DAYS = 90;

export interface RestockSettings {
  perEmailDailyCap: number;
  perShopDailyCap: number;
  sendRatePerRun: number;
  notifiedRetentionDays: number;
}

export async function loadRestockSettings(exec: Exec, shopId: string): Promise<RestockSettings> {
  const rows = await exec.rows<{
    per_email_daily_cap: number; per_shop_daily_cap: number;
    send_rate_per_run: number; notified_retention_days: number;
  }>(
    `SELECT per_email_daily_cap, per_shop_daily_cap, send_rate_per_run, notified_retention_days
     FROM restock_setting WHERE shop_id=$1::uuid`,
    [shopId],
  );
  const r = rows[0];
  if (!r) return { ...RESTOCK_DEFAULTS };
  return {
    perEmailDailyCap: Number(r.per_email_daily_cap),
    perShopDailyCap: Number(r.per_shop_daily_cap),
    sendRatePerRun: Number(r.send_rate_per_run),
    notifiedRetentionDays: Number(r.notified_retention_days),
  };
}

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

export async function saveRestockSettings(
  exec: Exec, shopId: string, input: Partial<RestockSettings>,
): Promise<RestockSettings> {
  const cur = await loadRestockSettings(exec, shopId);
  const next: RestockSettings = {
    perEmailDailyCap: input.perEmailDailyCap != null ? clamp(input.perEmailDailyCap, 1, 1000, cur.perEmailDailyCap) : cur.perEmailDailyCap,
    perShopDailyCap: input.perShopDailyCap != null ? clamp(input.perShopDailyCap, 1, 1000000, cur.perShopDailyCap) : cur.perShopDailyCap,
    sendRatePerRun: input.sendRatePerRun != null ? clamp(input.sendRatePerRun, 1, 10000, cur.sendRatePerRun) : cur.sendRatePerRun,
    notifiedRetentionDays: input.notifiedRetentionDays != null
      ? clamp(input.notifiedRetentionDays, 1, MAX_NOTIFIED_RETENTION_DAYS, cur.notifiedRetentionDays) : cur.notifiedRetentionDays,
  };
  await exec.run(
    `INSERT INTO restock_setting
       (shop_id, per_email_daily_cap, per_shop_daily_cap, send_rate_per_run, notified_retention_days, updated_at)
     VALUES ($1::uuid,$2::int,$3::int,$4::int,$5::int, now())
     ON CONFLICT (shop_id) DO UPDATE SET
       per_email_daily_cap=EXCLUDED.per_email_daily_cap, per_shop_daily_cap=EXCLUDED.per_shop_daily_cap,
       send_rate_per_run=EXCLUDED.send_rate_per_run, notified_retention_days=EXCLUDED.notified_retention_days,
       updated_at=now()`,
    [shopId, next.perEmailDailyCap, next.perShopDailyCap, next.sendRatePerRun, next.notifiedRetentionDays],
  );
  return next;
}
