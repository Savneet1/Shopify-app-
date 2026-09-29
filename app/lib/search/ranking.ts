import { TS_CONFIG } from "./config";

/**
 * Rule-based ranking (Phase 5.5). Deterministic, documented, no ML / no learned
 * weights / no personalization / no randomness.
 *
 * A product's score is:
 *     class_weight  (match class: sku > exact > prefix > synonym > fuzzy > partial)
 *   + field_score   (ts_rank_cd over the weighted tsvector: title > vendor/type >
 *                    tags > body — encoded by the A/B/C/D weights below)
 *   + in_stock_boost
 * ordered DESC, with a stable product-id tie-break. Class steps are far larger
 * than the bounded field_score + in_stock_boost, so match class always dominates,
 * then field weight, then availability, then the tie-break — exactly the stated
 * precedence. All weights live here with comments; per-shop overrides are left to
 * a later phase (kept simple on purpose — see docs/PHASE5.md).
 */

export const MATCH_CLASS = {
  sku: "sku",
  exact: "exact",
  prefix: "prefix",
  synonym: "synonym",
  fuzzy: "fuzzy",
  partial: "partial",
} as const;
export type MatchClass = (typeof MATCH_CLASS)[keyof typeof MATCH_CLASS];

/** Class weights — large, well-separated steps so class dominates the score. */
export const CLASS_WEIGHT: Record<MatchClass, number> = {
  sku: 600,
  exact: 500,
  prefix: 400,
  synonym: 300,
  fuzzy: 200,
  partial: 100,
};

/** ts_rank_cd field weights {D, C, B, A} = {body, tags, vendor/type, title}.
 * Title (A) highest, then vendor/type (B), then tags (C), then body (D). */
export const FIELD_WEIGHTS = { A: 1.0, B: 0.4, C: 0.2, D: 0.1 } as const;
/** Scales ts_rank_cd (≈0..1) into the score; stays < one class step (100). */
export const FIELD_SCALE = 50;
/** Additive boost for in-stock products; < FIELD_SCALE so field weight leads. */
export const IN_STOCK_BOOST = 10;

/** SQL array literal for ts_rank_cd weights: {D,C,B,A}. */
export function fieldWeightsSql(): string {
  return `'{${FIELD_WEIGHTS.D}, ${FIELD_WEIGHTS.C}, ${FIELD_WEIGHTS.B}, ${FIELD_WEIGHTS.A}}'::float4[]`;
}

/** ts_rank_cd expression against a given tsquery SQL fragment. */
export function fieldScoreSql(tsqueryFrag: string): string {
  return `ts_rank_cd(${fieldWeightsSql()}, tsv, ${tsqueryFrag})`;
}

/** to_tsquery over the shared config + accent folding. */
export function toTsQuery(lexParam: string): string {
  return `to_tsquery('${TS_CONFIG}', immutable_unaccent(${lexParam}))`;
}

export interface RankExplanation {
  matchClass: MatchClass;
  classWeight: number;
  fieldScore: number;
  inStock: boolean;
  inStockBoost: number;
  total: number;
}
