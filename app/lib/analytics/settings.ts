import type { Exec } from "~/lib/db/executor";

/**
 * Phase 11.2 — per-shop analytics settings. Default OFF (opt-in). Loading a
 * shop with no row returns the documented defaults; saving validates + clamps.
 */

export type AnalyticsMode = "off" | "anonymous" | "consented_sessions";

export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 395;
/** Partitions are dropped only once older than this hard cap (whole months),
 * guaranteeing no shop's configurable retention still needs them. */
export const PARTITION_RETENTION_DAYS = MAX_RETENTION_DAYS;
export const ROLLUP_RETENTION_DAYS = 400;

export interface AnalyticsSettings {
  mode: AnalyticsMode;
  retentionDays: number;
}

export const DEFAULT_SETTINGS: AnalyticsSettings = { mode: "off", retentionDays: DEFAULT_RETENTION_DAYS };

export async function loadAnalyticsSettings(exec: Exec, shopId: string): Promise<AnalyticsSettings> {
  const rows = await exec.rows<{ mode: AnalyticsMode; retention_days: number }>(
    `SELECT mode, retention_days FROM analytics_settings WHERE shop_id=$1::uuid`,
    [shopId],
  );
  const r = rows[0];
  if (!r) return { ...DEFAULT_SETTINGS };
  return { mode: r.mode, retentionDays: Number(r.retention_days) };
}

function clampRetention(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.max(1, Math.min(MAX_RETENTION_DAYS, n));
}

export async function saveAnalyticsSettings(
  exec: Exec, shopId: string, input: Partial<AnalyticsSettings>,
): Promise<AnalyticsSettings> {
  const cur = await loadAnalyticsSettings(exec, shopId);
  const mode: AnalyticsMode = input.mode && ["off", "anonymous", "consented_sessions"].includes(input.mode)
    ? input.mode : cur.mode;
  const retentionDays = input.retentionDays != null ? clampRetention(input.retentionDays) : cur.retentionDays;
  await exec.run(
    `INSERT INTO analytics_settings (shop_id, mode, retention_days, updated_at)
     VALUES ($1::uuid, $2, $3::int, now())
     ON CONFLICT (shop_id) DO UPDATE SET mode=EXCLUDED.mode, retention_days=EXCLUDED.retention_days, updated_at=now()`,
    [shopId, mode, retentionDays],
  );
  return { mode, retentionDays };
}
