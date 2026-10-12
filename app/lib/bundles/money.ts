/**
 * Phase 10.1 (M4b) — exact decimal money for bundle totals.
 *
 * Bundle totals / line totals / price ranges must NOT use binary floating point
 * (0.1 + 0.2 ≠ 0.3). We work in integer minor units scaled by the LARGEST number
 * of decimal places present in the input prices (minimum 2), using BigInt so the
 * arithmetic is exact and 3-decimal prices are never truncated, and format back
 * to a decimal string. Display currency formatting (symbol, grouping) is the
 * storefront's job via Intl; this only produces the exact numeric string.
 */

/** Decimal places in a numeric string ("12.345" → 3, "12" → 0). */
export function decimalPlaces(s: string): number {
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  return s.length - dot - 1;
}

/** Scale = max(2, max decimal places across the given price strings). */
export function scaleOf(prices: (string | null | undefined)[]): number {
  let scale = 2;
  for (const p of prices) {
    if (p == null || p === "") continue;
    scale = Math.max(scale, decimalPlaces(String(p)));
  }
  return scale;
}

/** Parse a decimal string to integer minor units at `scale` (BigInt, exact). */
export function toMinorAtScale(price: string | null | undefined, scale: number): bigint {
  if (price == null || price === "") return 0n;
  const neg = String(price).trim().startsWith("-");
  const s = String(price).trim().replace(/^[-+]/, "");
  const dot = s.indexOf(".");
  const intPart = dot < 0 ? s : s.slice(0, dot);
  let frac = dot < 0 ? "" : s.slice(dot + 1);
  if (frac.length > scale) frac = frac.slice(0, scale); // defensive; scale ≥ max places
  else frac = frac.padEnd(scale, "0");
  const digits = (intPart || "0") + frac;
  const clean = digits.replace(/[^0-9]/g, "") || "0";
  const v = BigInt(clean);
  return neg ? -v : v;
}

/** Format integer minor units back to a decimal string at `scale`. */
export function fromMinorAtScale(minor: bigint, scale: number): string {
  const neg = minor < 0n;
  let s = (neg ? -minor : minor).toString();
  if (scale === 0) return (neg ? "-" : "") + s;
  if (s.length <= scale) s = s.padStart(scale + 1, "0");
  const cut = s.length - scale;
  return (neg ? "-" : "") + s.slice(0, cut) + "." + s.slice(cut);
}

/** Line total = unitPrice × quantity, exact, as a decimal string at `scale`. */
export function lineTotalAtScale(unitPrice: string | null | undefined, quantity: number, scale: number): string | null {
  if (unitPrice == null || unitPrice === "") return null;
  const q = Math.max(0, Math.floor(Number(quantity) || 0));
  const minor = toMinorAtScale(unitPrice, scale) * BigInt(q);
  return fromMinorAtScale(minor, scale);
}

/** Sum of decimal strings (all at `scale`) as an exact decimal string. */
export function sumAtScale(values: (string | null | undefined)[], scale: number): string {
  let total = 0n;
  for (const v of values) total += toMinorAtScale(v, scale);
  return fromMinorAtScale(total, scale);
}
