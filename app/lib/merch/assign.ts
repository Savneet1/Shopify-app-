/**
 * Deterministic A/B assignment (Phase 8.5). Pure, no DB, no randomness in the
 * decision, no PII. The bucket is a stable hash of (shop, experiment, anonymous
 * visitor token) → [0,100); the visitor is assigned to variant B when the bucket
 * is below the experiment's split-to-B percentage, else A. A missing/empty token
 * means CONTROL (the default rule set) — never a random fallback. Same inputs
 * always produce the same variant, so a visitor sees a stable experience and the
 * split is reproducible.
 */

export type Variant = "control" | "A" | "B";

/** Strict UUID (v4-shaped) check for client-supplied ids before any ::uuid cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): boolean {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * sanitizeToken(raw): bound the anonymous A/B token at every read point. Returns
 * the token only when it is 1..64 chars of [A-Za-z0-9_-]; otherwise null (which
 * assignVariant treats as control). Never throws.
 */
export function sanitizeToken(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw);
  if (s.length < 1 || s.length > 64) return null;
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

/** FNV-1a 32-bit — small, fast, dependency-free, well-distributed for strings. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    // Keep two bytes split to stay in 32-bit range without BigInt.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Bucket in [0,100) for a seed. Deterministic. */
export function bucketOf(seed: string): number {
  return fnv1a32(seed) % 100;
}

/**
 * assignVariant(shopId, experimentId, token, splitPct): the variant for a
 * visitor. `splitPct` is the percentage routed to variant B (0..100). An empty
 * token → "control". Deterministic.
 */
export function assignVariant(
  shopId: string,
  experimentId: string,
  token: string | null | undefined,
  splitPct: number,
): Variant {
  if (token == null || String(token).trim() === "") return "control";
  const pct = Math.max(0, Math.min(100, Math.floor(Number(splitPct) || 0)));
  const bucket = bucketOf(`${shopId}:${experimentId}:${String(token).trim()}`);
  return bucket < pct ? "B" : "A";
}
