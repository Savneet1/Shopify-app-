import type { Exec } from "~/lib/db/executor";

/**
 * Phase 9.6 — per-shop recommendation settings (one row per shop, RLS-bound).
 * Load returns the stored row or documented defaults when none exists; save
 * validates + clamps every field. fbtEnabled defaults FALSE (no approved FBT
 * data source — see cooccurrence.ts / docs).
 */

export interface RecommendationSettings {
  similarEnabled: boolean;
  relatedEnabled: boolean;
  trendingEnabled: boolean;
  fbtEnabled: boolean;
  recentEnabled: boolean;
  includeOutOfStock: boolean;
  diversifyPerVendor: number; // 0..24; 0 = off
  fbtFallbackRelated: boolean;
  trendingHalfLifeDays: number; // 1..90
}

export const DEFAULT_SETTINGS: RecommendationSettings = {
  similarEnabled: true,
  relatedEnabled: true,
  trendingEnabled: true,
  fbtEnabled: false,
  recentEnabled: true,
  includeOutOfStock: false,
  diversifyPerVendor: 0,
  fbtFallbackRelated: true,
  trendingHalfLifeDays: 7,
};

interface Row {
  similar_enabled: boolean;
  related_enabled: boolean;
  trending_enabled: boolean;
  fbt_enabled: boolean;
  recent_enabled: boolean;
  include_out_of_stock: boolean;
  diversify_per_vendor: number;
  fbt_fallback_related: boolean;
  trending_half_life_days: number;
}

export async function loadSettings(exec: Exec, shopId: string): Promise<RecommendationSettings> {
  const rows = await exec.rows<Row>(
    `SELECT similar_enabled, related_enabled, trending_enabled, fbt_enabled, recent_enabled,
            include_out_of_stock, diversify_per_vendor, fbt_fallback_related, trending_half_life_days
     FROM recommendation_settings WHERE shop_id = $1::uuid`,
    [shopId],
  );
  const r = rows[0];
  if (!r) return { ...DEFAULT_SETTINGS };
  return {
    similarEnabled: r.similar_enabled,
    relatedEnabled: r.related_enabled,
    trendingEnabled: r.trending_enabled,
    fbtEnabled: r.fbt_enabled,
    recentEnabled: r.recent_enabled,
    includeOutOfStock: r.include_out_of_stock,
    diversifyPerVendor: Number(r.diversify_per_vendor),
    fbtFallbackRelated: r.fbt_fallback_related,
    trendingHalfLifeDays: Number(r.trending_half_life_days),
  };
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

export async function saveSettings(
  exec: Exec,
  shopId: string,
  input: Partial<RecommendationSettings>,
): Promise<RecommendationSettings> {
  const cur = await loadSettings(exec, shopId);
  const next: RecommendationSettings = {
    similarEnabled: input.similarEnabled ?? cur.similarEnabled,
    relatedEnabled: input.relatedEnabled ?? cur.relatedEnabled,
    trendingEnabled: input.trendingEnabled ?? cur.trendingEnabled,
    fbtEnabled: input.fbtEnabled ?? cur.fbtEnabled,
    recentEnabled: input.recentEnabled ?? cur.recentEnabled,
    includeOutOfStock: input.includeOutOfStock ?? cur.includeOutOfStock,
    diversifyPerVendor: clampInt(input.diversifyPerVendor ?? cur.diversifyPerVendor, 0, 24, 0),
    fbtFallbackRelated: input.fbtFallbackRelated ?? cur.fbtFallbackRelated,
    trendingHalfLifeDays: clampInt(input.trendingHalfLifeDays ?? cur.trendingHalfLifeDays, 1, 90, 7),
  };
  await exec.run(
    `INSERT INTO recommendation_settings
       (shop_id, similar_enabled, related_enabled, trending_enabled, fbt_enabled, recent_enabled,
        include_out_of_stock, diversify_per_vendor, fbt_fallback_related, trending_half_life_days, updated_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::int,$9,$10::int, now())
     ON CONFLICT (shop_id) DO UPDATE SET
       similar_enabled=EXCLUDED.similar_enabled, related_enabled=EXCLUDED.related_enabled,
       trending_enabled=EXCLUDED.trending_enabled, fbt_enabled=EXCLUDED.fbt_enabled,
       recent_enabled=EXCLUDED.recent_enabled, include_out_of_stock=EXCLUDED.include_out_of_stock,
       diversify_per_vendor=EXCLUDED.diversify_per_vendor, fbt_fallback_related=EXCLUDED.fbt_fallback_related,
       trending_half_life_days=EXCLUDED.trending_half_life_days, updated_at=now()`,
    [
      shopId, next.similarEnabled, next.relatedEnabled, next.trendingEnabled, next.fbtEnabled,
      next.recentEnabled, next.includeOutOfStock, next.diversifyPerVendor, next.fbtFallbackRelated,
      next.trendingHalfLifeDays,
    ],
  );
  return next;
}
