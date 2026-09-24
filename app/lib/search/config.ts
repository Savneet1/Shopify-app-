/**
 * Centralised text-search configuration (Phase 3).
 *
 * Stemming/language decision: PostgreSQL 'english' (Snowball) config, applied to
 * accent-folded text via immutable_unaccent(). This gives light English stemming
 * (running -> run, shoes -> shoe) and accent-insensitive matching, which is a
 * sensible baseline for an English-first catalog.
 *
 * SCOPE BOUNDARY: this is a BASELINE only. Configurable language/config per
 * shop/market, synonyms, stop-word rules, redirects and typo tolerance
 * (Damerau-Levenshtein) are Phase 5/13 — do NOT add them here. pg_trgm is used
 * ONLY for prefix/substring acceleration and the last-resort zero-result
 * fallback, never as typo tolerance.
 *
 * Everything that names the config lives here so later phases change one place.
 */
export const TS_CONFIG = "english";

/** Wrap a text SQL expression as accent-folded to_tsvector in the shared config. */
export function tsvExpr(sqlTextExpr: string): string {
  return `to_tsvector('${TS_CONFIG}', immutable_unaccent(coalesce(${sqlTextExpr}, '')))`;
}

/**
 * Weighted document vector: A title; B vendor/product type/SKU+barcode;
 * C tags/collection titles/variant titles; D description.
 */
export function weightedTsvSql(a: string, b: string, c: string, d: string): string {
  return [
    `setweight(${tsvExpr(a)}, 'A')`,
    `setweight(${tsvExpr(b)}, 'B')`,
    `setweight(${tsvExpr(c)}, 'C')`,
    `setweight(${tsvExpr(d)}, 'D')`,
  ].join(" || ");
}
