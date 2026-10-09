/**
 * Phase 9 — product reference validation (pure, no DB, no throw).
 *
 * The storefront identifies a product to the recommendations API by one of three
 * forms: an internal UUID, a Shopify product GID (gid://shopify/Product/<n>), or
 * a storefront handle. EVERY client-supplied ref is validated and classified
 * here BEFORE it is ever bound into SQL — a ref that does not match one of the
 * three strict shapes is dropped (never cast, never concatenated). This mirrors
 * the Phase 8 beacon discipline (assign.isUuid before any ::uuid cast).
 */

import { isUuid } from "~/lib/merch/assign";

export type RefKind = "uuid" | "gid" | "handle";
export interface ProductRef {
  kind: RefKind;
  value: string;
}

/** gid://shopify/Product/<digits> — the only accepted GID shape. */
const GID_RE = /^gid:\/\/shopify\/Product\/\d{1,20}$/;
/** Shopify storefront handle: lowercase alphanumerics + hyphen/underscore, must
 * start and end with an alphanumeric, length 1..100. Deliberately strict. */
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;

export const MAX_RECENT_IDS = 12;

export function isGid(v: unknown): boolean {
  return typeof v === "string" && GID_RE.test(v);
}

export function isHandle(v: unknown): boolean {
  return typeof v === "string" && HANDLE_RE.test(v);
}

/**
 * Classify a single raw ref. UUID first (unambiguous), then GID, then handle on
 * the lower-cased value. Returns null for anything else (empty, oversize,
 * control chars, other schemes, …). Never throws.
 */
export function classifyRef(raw: unknown): ProductRef | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s.length === 0 || s.length > 255) return null;
  if (isUuid(s)) return { kind: "uuid", value: s };
  if (isGid(s)) return { kind: "gid", value: s };
  const lower = s.toLowerCase();
  if (isHandle(lower)) return { kind: "handle", value: lower };
  return null;
}

/**
 * Parse a "recently viewed" param: a comma-separated string or an array of
 * refs. Validates + classifies each, DROPS invalid ones, de-duplicates by
 * normalized value (first occurrence wins, preserving order), and caps the list
 * at {@link MAX_RECENT_IDS}. Never throws. Order is preserved so a
 * most-recent-first client list stays most-recent-first.
 */
export function parseRecentRefs(raw: unknown, max = MAX_RECENT_IDS): ProductRef[] {
  let parts: unknown[];
  if (Array.isArray(raw)) parts = raw;
  else if (raw == null) parts = [];
  else parts = String(raw).split(",");
  const out: ProductRef[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (out.length >= max) break;
    const ref = classifyRef(p);
    if (!ref) continue;
    const key = `${ref.kind}:${ref.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Split a list of refs into the three typed arrays used to match in SQL. */
export function partitionRefs(refs: ProductRef[]): {
  uuids: string[];
  gids: string[];
  handles: string[];
} {
  const uuids: string[] = [];
  const gids: string[] = [];
  const handles: string[] = [];
  for (const r of refs) {
    if (r.kind === "uuid") uuids.push(r.value);
    else if (r.kind === "gid") gids.push(r.value);
    else handles.push(r.value);
  }
  return { uuids, gids, handles };
}
