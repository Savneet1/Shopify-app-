/**
 * Shared text normalisation, tokenisation and token classification (Phase 5).
 * Used by search, predictive, facets, redirects and the vocabulary builder so
 * every path agrees on what a "term" is.
 */

/** Normalise a query for redirect matching: lower-case, fold punctuation to
 * spaces, collapse whitespace. (case, whitespace, punctuation). */
export function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split into lowercased [\p{L}\p{N}] tokens (maximal alnum runs), capped. */
export function tokenize(q: string): string[] {
  const m = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return m ? m.slice(0, 24) : [];
}

/** Pure-digit token (e.g. "2024", "42"). */
export function isNumericToken(t: string): boolean {
  return /^\p{Nd}+$/u.test(t);
}

/** Code/SKU-like token: mixes letters and digits (e.g. "abc123", "x1"). */
export function isCodeLikeToken(t: string): boolean {
  return /\p{L}/u.test(t) && /\p{Nd}/u.test(t);
}

/**
 * A token is eligible for fuzzy correction only if it is neither numeric nor
 * code/SKU-like — "Never fuzzy-match numeric tokens or SKUs". (Hyphenated codes
 * like "RUN-1" tokenise to "run" + "1"; the numeric part is excluded and the
 * exact SKU path — a whole-token match on sku_text — always outranks fuzzy, so
 * real code searches are served exactly, not corrected. See docs/PHASE5.md.)
 */
export function isFuzzable(t: string): boolean {
  return !isNumericToken(t) && !isCodeLikeToken(t);
}
