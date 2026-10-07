import { TS_CONFIG, FACET_METAFIELD_MAPKEY } from "./config";
import { stripControl } from "./text";

/**
 * Phase 4 filter model + parameterised predicate builders.
 *
 * Everything here is built with a {@link Params} accumulator so user values are
 * ALWAYS bound parameters ($1, $2, …) — never string-concatenated into SQL. The
 * SAME builders produce the visibility, collection-scope, text-match and filter
 * predicates for BOTH the product query (app/lib/search/query.ts) and the facet
 * counts (app/lib/search/facets.ts), so facets can never drift from results.
 *
 * Filter semantics (documented for review):
 *  - Within a multi-value facet group (vendor / product_type / tags / metafield)
 *    the values combine with OR — selecting two vendors shows products from
 *    either. (`= ANY(array)` for single-value columns; array `&&` overlap for
 *    tags.) This is the conventional faceted-navigation behaviour: choices
 *    within one attribute broaden the set.
 *  - Different facet groups combine with AND — vendor AND product_type AND
 *    price AND … — so choices across attributes narrow the set.
 *  - Price is an overlap test: a product (price_min..price_max) matches when its
 *    range overlaps the requested [min, max].
 */

export type FacetGroup =
  | "vendor"
  | "productType"
  | "tags"
  | "price"
  | "available"
  | "metafield";

export interface RawFilters {
  vendor?: string[] | string;
  productType?: string[] | string;
  tags?: string[] | string;
  priceMin?: number | string | null;
  priceMax?: number | string | null;
  available?: boolean | string | null;
  collectionId?: string | null;
  /** Values for the ONE configured metafield facet. */
  metafield?: string[] | string;
}

export interface SearchFilters {
  vendor: string[];
  productType: string[];
  tags: string[];
  priceMin: number | null;
  priceMax: number | null;
  available: boolean | null;
  collectionId: string | null;
  metafield: string[];
}

export class FilterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterValidationError";
  }
}

export const MAX_FILTER_VALUES = 50; // per multi-value group
export const MAX_FILTER_STR = 100; // per value
export const MAX_COLLECTION_ID = 255;
export const MAX_PRICE = 1_000_000_000;

function toArray(v: string[] | string | undefined, field: string): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  if (arr.length > MAX_FILTER_VALUES) {
    throw new FilterValidationError(`too many values for '${field}' (max ${MAX_FILTER_VALUES})`);
  }
  const out: string[] = [];
  for (const raw of arr) {
    if (raw == null) continue;
    const s = stripControl(String(raw)).trim(); // A4: no control chars reach SQL
    if (s.length === 0) continue;
    if (s.length > MAX_FILTER_STR) {
      throw new FilterValidationError(`value too long for '${field}' (max ${MAX_FILTER_STR})`);
    }
    out.push(s);
  }
  return out;
}

function toPrice(v: number | string | null | undefined, field: string): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
    throw new FilterValidationError(`invalid '${field}' (expected 0..${MAX_PRICE})`);
  }
  return n;
}

function toBool(v: boolean | string | null | undefined): boolean | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  throw new FilterValidationError("invalid 'available' (expected true/false)");
}

/** Validate + cap raw filter input. Throws FilterValidationError on malformed
 * input so the route can return a clean 400 (never a 500). */
export function normalizeFilters(raw: RawFilters | undefined): SearchFilters {
  const f = raw ?? {};
  const priceMin = toPrice(f.priceMin, "priceMin");
  const priceMax = toPrice(f.priceMax, "priceMax");
  if (priceMin != null && priceMax != null && priceMin > priceMax) {
    throw new FilterValidationError("priceMin must be <= priceMax");
  }
  let collectionId: string | null = null;
  if (f.collectionId != null && stripControl(String(f.collectionId)).trim() !== "") {
    collectionId = stripControl(String(f.collectionId)).trim();
    if (collectionId.length > MAX_COLLECTION_ID) {
      throw new FilterValidationError(`collectionId too long (max ${MAX_COLLECTION_ID})`);
    }
  }
  return {
    vendor: toArray(f.vendor, "vendor"),
    productType: toArray(f.productType, "productType"),
    tags: toArray(f.tags, "tags"),
    priceMin,
    priceMax,
    available: toBool(f.available),
    collectionId,
    metafield: toArray(f.metafield, "metafield"),
  };
}

export function hasAnyFilter(f: SearchFilters): boolean {
  return (
    f.vendor.length > 0 ||
    f.productType.length > 0 ||
    f.tags.length > 0 ||
    f.priceMin != null ||
    f.priceMax != null ||
    f.available != null ||
    f.collectionId != null ||
    f.metafield.length > 0
  );
}

/** Positional parameter accumulator: user values are always bound, never inlined. */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** Visibility predicate — the SINGLE source reused by search AND facets:
 * active version + published to Online Store + status ACTIVE. */
export function visibilityPredicate(pb: Params, shopId: string, versionId: string): string {
  return `shop_id = ${pb.add(shopId)}::uuid AND index_version_id = ${pb.add(versionId)}::uuid
    AND published = true AND status = 'ACTIVE'`;
}

/** Collection-scope predicate (Phase 4.4): restrict to members of the given
 * Shopify collection GID. Returns null when no collection is scoped. */
export function collectionPredicate(pb: Params, shopId: string, collectionId: string | null): string | null {
  if (!collectionId) return null;
  const sid = pb.add(shopId);
  const gid = pb.add(collectionId);
  return `product_id IN (
    SELECT pc.product_id FROM product_collection pc
    JOIN collection col ON col.id = pc.collection_id
    WHERE col.shop_id = ${sid}::uuid AND col.shopify_collection_gid = ${gid} AND col.deleted_at IS NULL)`;
}

/** AND-able filter predicates for every active group EXCEPT `exclude`
 * (exclude is used for a facet's own-selection: a facet's counts reflect all
 * OTHER active filters, not its own). */
export function filterPredicates(pb: Params, f: SearchFilters, exclude?: FacetGroup): string[] {
  const out: string[] = [];
  if (exclude !== "vendor" && f.vendor.length) out.push(`vendor = ANY(${pb.add(f.vendor)}::text[])`);
  if (exclude !== "productType" && f.productType.length) out.push(`product_type = ANY(${pb.add(f.productType)}::text[])`);
  if (exclude !== "tags" && f.tags.length) out.push(`tags && ${pb.add(f.tags)}::text[]`);
  if (exclude !== "price" && (f.priceMin != null || f.priceMax != null)) {
    if (f.priceMin != null) out.push(`price_max >= ${pb.add(f.priceMin)}::numeric`);
    if (f.priceMax != null) out.push(`price_min <= ${pb.add(f.priceMax)}::numeric`);
  }
  if (exclude !== "available" && f.available != null) out.push(`available = ${pb.add(f.available)}::boolean`);
  if (exclude !== "metafield" && f.metafield.length) {
    out.push(`metafields->>${pb.add(FACET_METAFIELD_MAPKEY)} = ANY(${pb.add(f.metafield)}::text[])`);
  }
  return out;
}

// ---- Text matching (shared with the Phase 3 cascade) ---------------------

export type Strategy = "browse" | "exact_sku" | "and" | "prefix" | "or" | "trigram" | "none";

/** [\p{L}\p{N}] tokens, lower-cased, capped. */
export function queryTokens(q: string): string[] {
  const m = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return m ? m.filter((t) => t.length > 0).slice(0, 16) : [];
}

export function prefixLexemes(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}:*` : t)).join(" & ");
}
export function orLexemes(tokens: string[]): string | null {
  return tokens.length === 0 ? null : tokens.join(" | ");
}

/** Whole-token exact SKU/barcode probe. */
export function skuHitPredicate(pb: Params, q: string): string {
  return `(' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower(${pb.add(q)}) || ' %')`;
}

/** The FTS predicate for one broadening stage. */
export function ftsPredicate(pb: Params, stage: Exclude<Strategy, "browse" | "exact_sku" | "none">, q: string, lex: string | null): string {
  if (stage === "and") return `tsv @@ websearch_to_tsquery('${TS_CONFIG}', immutable_unaccent(${pb.add(q)}))`;
  if (stage === "trigram") return `immutable_unaccent(lower(coalesce(title,''))) %> immutable_unaccent(lower(${pb.add(q)}))`;
  // prefix / or use a sanitised lexeme string.
  return `tsv @@ to_tsquery('${TS_CONFIG}', immutable_unaccent(${pb.add(lex ?? "")}))`;
}

/** The rank expression for one stage (baseline ts_rank_cd / word_similarity). */
export function rankExpr(pb: Params, stage: Exclude<Strategy, "browse" | "exact_sku" | "none">, q: string, lex: string | null): string {
  if (stage === "and") return `ts_rank_cd(tsv, websearch_to_tsquery('${TS_CONFIG}', immutable_unaccent(${pb.add(q)})))`;
  if (stage === "trigram") return `word_similarity(immutable_unaccent(lower(${pb.add(q)})), immutable_unaccent(lower(coalesce(title,''))))`;
  return `ts_rank_cd(tsv, to_tsquery('${TS_CONFIG}', immutable_unaccent(${pb.add(lex ?? "")})))`;
}
