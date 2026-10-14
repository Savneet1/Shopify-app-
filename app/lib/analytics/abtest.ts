/**
 * Phase 11.5 — A/B readout. Pure, deterministic statistics over per-variant
 * event counts (the events carry experiment_id + variant tags from Phase 8).
 * We report per-variant searches, clicks, CTR and add-to-cart rate, and a
 * two-proportion z-test comparing a variant to control (or A vs B) — but ONLY
 * when both arms clear documented minimum-sample thresholds. Below threshold we
 * say "inconclusive — not enough data". We NEVER claim causal lift or revenue
 * (there is no order data). No randomness, no timing.
 */

/** Minimum successes AND trials each arm must have before a z-test is shown. */
export const MIN_TRIALS_PER_ARM = 100;
export const MIN_SUCCESSES_PER_ARM = 10;
/** |z| >= 1.96 ≈ two-sided p < 0.05. Documented, not learned. */
export const Z_SIGNIFICANT = 1.96;

export interface Proportion { successes: number; trials: number }

/** Two-proportion z-statistic (pooled). Returns null when a denominator is 0. */
export function twoProportionZ(a: Proportion, b: Proportion): number | null {
  const n1 = Math.max(0, Math.floor(a.trials));
  const n2 = Math.max(0, Math.floor(b.trials));
  const x1 = Math.max(0, Math.floor(a.successes));
  const x2 = Math.max(0, Math.floor(b.successes));
  if (n1 === 0 || n2 === 0) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pPool = (x1 + x2) / (n1 + n2);
  const denom = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (denom === 0) return null; // both arms all-success or all-failure
  return (p1 - p2) / denom;
}

export type ABVerdict = "significant" | "not_significant" | "inconclusive_sample";

export interface ABComparison {
  z: number | null;
  verdict: ABVerdict;
  note: string;
}

/**
 * Compare two arms on a success/trial proportion with the sample gate applied
 * first. Below the thresholds → "inconclusive — not enough data" and no z.
 */
export function compareArms(a: Proportion, b: Proportion): ABComparison {
  const enough = (p: Proportion) => p.trials >= MIN_TRIALS_PER_ARM && p.successes >= MIN_SUCCESSES_PER_ARM;
  if (!enough(a) || !enough(b)) {
    return { z: null, verdict: "inconclusive_sample", note: "inconclusive — not enough data" };
  }
  const z = twoProportionZ(a, b);
  if (z === null) return { z: null, verdict: "inconclusive_sample", note: "inconclusive — not enough data" };
  const significant = Math.abs(z) >= Z_SIGNIFICANT;
  return {
    z,
    verdict: significant ? "significant" : "not_significant",
    note: significant
      ? "difference is statistically significant (p < 0.05); not a causal or revenue claim"
      : "no statistically significant difference at p < 0.05",
  };
}

export interface VariantStats {
  variant: string;
  searches: number;
  clicks: number;
  addToCart: number;
  ctr: number;
  addToCartRate: number;
}

export function variantStats(variant: string, searches: number, clicks: number, addToCart: number): VariantStats {
  const ratio = (n: number) => (searches > 0 ? n / searches : 0);
  return { variant, searches, clicks, addToCart, ctr: ratio(clicks), addToCartRate: ratio(addToCart) };
}
