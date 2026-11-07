/**
 * Phase 14.1 — percentile + summary math for the benchmark harness. Pure and
 * self-tested. Uses the "nearest-rank" method on a sorted copy (deterministic,
 * no interpolation surprises).
 */

export interface Summary {
  n: number; min: number; max: number; mean: number;
  p50: number; p95: number; p99: number;
}

/** Nearest-rank percentile: p in [0,100]. Empty → 0. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length); // 1-based
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(samples: number[]): Summary {
  if (samples.length === 0) return { n: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of samples) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  return {
    n: samples.length, min, max, mean: sum / samples.length,
    p50: percentile(samples, 50), p95: percentile(samples, 95), p99: percentile(samples, 99),
  };
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;
