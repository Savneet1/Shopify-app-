/**
 * Phase 10.3 — bundle discount calculator (PURE reference logic).
 *
 * IMPORTANT: this module is NEVER used to show a price or discount to a shopper.
 * This app has no `write_discounts` scope and deploys no Shopify Function, so no
 * discount is ever applied. The storefront only ever shows the sum of regular
 * prices ("Total"). This calculator exists as the fully-tested reference
 * implementation that a FUTURE Shopify Function (with the proper scope) would
 * port — see docs/PHASE10.md for exactly what that requires.
 *
 * All money is handled in INTEGER MINOR UNITS (e.g. cents) to avoid floating
 * point error. Currencies differ in how many minor digits they use (JPY 0,
 * most 2, KWD/BHD 3); the caller passes `minorDigits`. Guarantees:
 *   - the computed discount is never negative and never exceeds the subtotal
 *     (so the bundle total never drops below zero and a "fixed price" above the
 *     subtotal yields a zero discount);
 *   - rounding is half-up on the absolute value (deterministic);
 *   - per-quantity line totals (unit × qty) are summed exactly in minor units.
 */

export type DiscountType = "percent" | "fixed_amount" | "fixed_price";

export interface DiscountSpec {
  type: DiscountType;
  /** percent: 0..100; fixed_amount / fixed_price: a money amount in MAJOR units. */
  value: number;
}

export interface BundleLine {
  /** Unit price in minor units (integer). */
  unitPriceMinor: number;
  /** Quantity (integer ≥ 1). */
  quantity: number;
}

export interface DiscountResult {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
}

/** Round half-up on the absolute value, deterministic (no Math.round bias at .5 of negatives). */
export function roundHalfUp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(n) + 0.5);
}

/** Convert a MAJOR-unit money amount to integer minor units for `minorDigits`. */
export function toMinor(major: number, minorDigits: number): number {
  const d = clampDigits(minorDigits);
  if (!Number.isFinite(major) || major < 0) return 0;
  return roundHalfUp(major * Math.pow(10, d));
}

function clampDigits(d: number): number {
  const n = Math.floor(Number(d));
  if (!Number.isFinite(n) || n < 0) return 2;
  return n > 4 ? 4 : n;
}

function toInt(n: number, min = 0): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v;
}

/** Subtotal of the bundle lines in minor units (Σ unit × qty). */
export function subtotalMinor(lines: BundleLine[]): number {
  let sum = 0;
  for (const l of lines) sum += toInt(l.unitPriceMinor) * toInt(l.quantity, 1);
  return sum;
}

/**
 * Compute the (hypothetical) discounted total for a set of bundle lines. Returns
 * minor-unit subtotal, discount and total, with the discount clamped to
 * [0, subtotal]. Deterministic and side-effect free.
 */
export function computeBundleDiscount(
  lines: BundleLine[],
  spec: DiscountSpec | null | undefined,
  minorDigits = 2,
): DiscountResult {
  const subtotal = subtotalMinor(lines);
  if (!spec) return { subtotalMinor: subtotal, discountMinor: 0, totalMinor: subtotal };

  let discount = 0;
  if (spec.type === "percent") {
    const pct = Math.max(0, Math.min(100, Number(spec.value) || 0));
    discount = roundHalfUp((subtotal * pct) / 100);
  } else if (spec.type === "fixed_amount") {
    discount = toMinor(Math.max(0, Number(spec.value) || 0), minorDigits);
  } else if (spec.type === "fixed_price") {
    // The bundle is meant to cost `value`; the discount is whatever brings the
    // subtotal down to it. A target above the subtotal → zero discount.
    const targetMinor = toMinor(Math.max(0, Number(spec.value) || 0), minorDigits);
    discount = subtotal - targetMinor;
  }

  // Clamp: never negative, never more than the subtotal.
  discount = Math.max(0, Math.min(subtotal, roundHalfUp(discount)));
  return { subtotalMinor: subtotal, discountMinor: discount, totalMinor: subtotal - discount };
}
