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

/**
 * Phase 4 — the ONE proof-of-concept metafield facet + the extension point.
 * A single-value, exact-match facet over a configured (namespace, key). Only
 * this namespace is captured from the catalog and only this key is faceted;
 * full metafield-type coverage (list/boolean/number/date/money/…) is out of
 * Phase 4 scope (see docs/PHASE4.md). Configurable via env so a merchant/dev can
 * point it at their own metafield without code changes.
 *
 * Which metafields are actually returned by the Admin API depends on each
 * metafield's access controls under the existing read_products scope
 * (REQUIRES VERIFICATION per store) — no new scope is requested.
 */
export const FACET_METAFIELD = {
  namespace: process.env.FACET_METAFIELD_NAMESPACE || "custom",
  key: process.env.FACET_METAFIELD_KEY || "material",
  label: process.env.FACET_METAFIELD_LABEL || "Material",
} as const;

/** Flat map key used in product.metafields / product_search_doc.metafields. */
export const FACET_METAFIELD_MAPKEY = `${FACET_METAFIELD.namespace}.${FACET_METAFIELD.key}`;

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
