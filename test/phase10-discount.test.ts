import { describe, it, expect } from "vitest";
import {
  computeBundleDiscount, subtotalMinor, toMinor, roundHalfUp, type BundleLine,
} from "~/lib/bundles/discount";

/*
 * Phase 10.3 — pure bundle discount calculator (reference logic; never shown to
 * shoppers). No DB. Deterministic.
 */
const lines = (pairs: [number, number][]): BundleLine[] =>
  pairs.map(([unitPriceMinor, quantity]) => ({ unitPriceMinor, quantity }));

describe("Phase 10.3 — discount calculator", () => {
  it("subtotal sums unit × quantity in minor units", () => {
    expect(subtotalMinor(lines([[1000, 2], [550, 1]]))).toBe(2550);
    expect(subtotalMinor([])).toBe(0);
  });

  it("no spec → total equals subtotal", () => {
    const r = computeBundleDiscount(lines([[1000, 2]]), null);
    expect(r).toEqual({ subtotalMinor: 2000, discountMinor: 0, totalMinor: 2000 });
  });

  it("percent off, rounded half-up", () => {
    // 10% of 2550 = 255
    expect(computeBundleDiscount(lines([[1000, 2], [550, 1]]), { type: "percent", value: 10 }).discountMinor).toBe(255);
    // 33% of 1000 = 330 (330.0) ; 33% of 1001 = 330.33 → 330
    expect(computeBundleDiscount(lines([[1001, 1]]), { type: "percent", value: 33 }).discountMinor).toBe(330);
    // half-up: 5% of 4510 = 225.5 → 226
    expect(computeBundleDiscount(lines([[4510, 1]]), { type: "percent", value: 5 }).discountMinor).toBe(226);
  });

  it("percent clamps to 0..100", () => {
    expect(computeBundleDiscount(lines([[1000, 1]]), { type: "percent", value: 150 }).discountMinor).toBe(1000);
    expect(computeBundleDiscount(lines([[1000, 1]]), { type: "percent", value: -5 }).discountMinor).toBe(0);
  });

  it("fixed_amount converts major→minor by currency digits", () => {
    // $5.00 off, 2 digits → 500 minor
    expect(computeBundleDiscount(lines([[1000, 1]]), { type: "fixed_amount", value: 5 }, 2).discountMinor).toBe(500);
    // ¥5 off, 0-digit currency → 5 minor
    expect(computeBundleDiscount(lines([[1000, 1]]), { type: "fixed_amount", value: 5 }, 0).discountMinor).toBe(5);
    // 3-digit currency (KWD) 1.5 → 1500 minor
    expect(computeBundleDiscount(lines([[5000, 1]]), { type: "fixed_amount", value: 1.5 }, 3).discountMinor).toBe(1500);
  });

  it("fixed_amount never exceeds the subtotal", () => {
    const r = computeBundleDiscount(lines([[1000, 1]]), { type: "fixed_amount", value: 50 }, 2);
    expect(r.discountMinor).toBe(1000);
    expect(r.totalMinor).toBe(0);
  });

  it("fixed_price sets the target; above subtotal → no discount", () => {
    // subtotal 2000, target $12.00 → discount 800, total 1200
    const r = computeBundleDiscount(lines([[1000, 2]]), { type: "fixed_price", value: 12 }, 2);
    expect(r.discountMinor).toBe(800);
    expect(r.totalMinor).toBe(1200);
    // target above subtotal → zero discount (never negative)
    const hi = computeBundleDiscount(lines([[1000, 2]]), { type: "fixed_price", value: 99 }, 2);
    expect(hi.discountMinor).toBe(0);
    expect(hi.totalMinor).toBe(2000);
  });

  it("never returns a negative total or negative discount", () => {
    for (const spec of [
      { type: "percent" as const, value: 999 },
      { type: "fixed_amount" as const, value: 1e9 },
      { type: "fixed_price" as const, value: 0 },
    ]) {
      const r = computeBundleDiscount(lines([[1234, 3]]), spec, 2);
      expect(r.discountMinor).toBeGreaterThanOrEqual(0);
      expect(r.discountMinor).toBeLessThanOrEqual(r.subtotalMinor);
      expect(r.totalMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it("tolerates junk input without throwing", () => {
    const r = computeBundleDiscount(lines([[NaN as any, 2], [1000, -3]]), { type: "percent", value: NaN as any });
    expect(Number.isFinite(r.subtotalMinor)).toBe(true);
    expect(r.discountMinor).toBe(0);
  });

  it("helpers: roundHalfUp and toMinor", () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(2.49)).toBe(2);
    expect(roundHalfUp(-0.5)).toBe(-1);
    expect(toMinor(1.01, 2)).toBe(101);
    expect(toMinor(2.5, 2)).toBe(250);
    expect(toMinor(-5, 2)).toBe(0);
    expect(toMinor(5, 9)).toBe(toMinor(5, 4)); // digits clamped to 4
  });
});
