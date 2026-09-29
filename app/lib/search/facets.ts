import type { Exec } from "~/lib/db/executor";
import { Params, type SearchFilters, type FacetGroup } from "./filters";
import { buildWhere, type Matcher, type Stage } from "./query";
import { FACET_METAFIELD, FACET_METAFIELD_MAPKEY } from "./config";

/**
 * Phase 4.2 facet counting.
 *
 * The "own selection doesn't zero itself" rule: a facet's option counts reflect
 * every OTHER active filter but NOT the facet's own selection. So selecting
 * "Vendor = Nike" must not make every other vendor's count disappear — the
 * vendor facet is counted with the vendor filter EXCLUDED (buildWhere(..,
 * exclude:"vendor")), while all other filters (and the text match, collection
 * scope, and visibility) still apply. Each facet is a separate GROUP BY count
 * query; every value is a bound parameter (no string-concatenated SQL).
 *
 * Counts are computed over the SAME matched + filtered + visible set as the
 * product results (same `matcher`, same `buildWhere`), so facets never drift.
 */

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}
export interface Facet {
  key: string;
  label: string;
  options: FacetOption[];
}
export interface FacetsResult {
  facets: Facet[];
  priceRange: { min: string; max: string } | null;
}

const FACET_OPTION_LIMIT = 50;

function stageOf(m: Matcher): { stage: Stage | null; lex: string | null } {
  if (m.kind === "browse") return { stage: null, lex: null };
  return { stage: m.stage, lex: m.lex };
}

/** Single-column GROUP BY facet (vendor / product_type). */
async function columnFacet(
  exec: Exec,
  shopId: string,
  versionId: string,
  q: string,
  filters: SearchFilters,
  matcher: Matcher,
  group: FacetGroup,
  column: string,
): Promise<FacetOption[]> {
  const pb = new Params();
  const { stage, lex } = stageOf(matcher);
  const where = buildWhere(pb, shopId, versionId, filters, stage, q, lex, group);
  const sql = `
    SELECT ${column} AS value, count(*)::int AS count
    FROM product_search_doc
    WHERE ${where} AND ${column} IS NOT NULL AND ${column} <> ''
    GROUP BY ${column}
    ORDER BY count DESC, value ASC
    LIMIT ${FACET_OPTION_LIMIT}`;
  const rows = await exec.rows<{ value: string; count: number }>(sql, pb.values);
  return rows.map((r) => ({ value: r.value, label: r.value, count: r.count }));
}

/** Multi-value tags facet: unnest the tags array within the filtered set. */
async function tagsFacet(
  exec: Exec,
  shopId: string,
  versionId: string,
  q: string,
  filters: SearchFilters,
  matcher: Matcher,
): Promise<FacetOption[]> {
  const pb = new Params();
  const { stage, lex } = stageOf(matcher);
  const where = buildWhere(pb, shopId, versionId, filters, stage, q, lex, "tags");
  const sql = `
    SELECT t AS value, count(*)::int AS count
    FROM product_search_doc psd, unnest(psd.tags) AS t
    WHERE ${where}
    GROUP BY t
    ORDER BY count DESC, value ASC
    LIMIT ${FACET_OPTION_LIMIT}`;
  const rows = await exec.rows<{ value: string; count: number }>(sql, pb.values);
  return rows.map((r) => ({ value: r.value, label: r.value, count: r.count }));
}

/** Availability facet: in-stock vs out-of-stock counts. */
async function availabilityFacet(
  exec: Exec,
  shopId: string,
  versionId: string,
  q: string,
  filters: SearchFilters,
  matcher: Matcher,
): Promise<FacetOption[]> {
  const pb = new Params();
  const { stage, lex } = stageOf(matcher);
  const where = buildWhere(pb, shopId, versionId, filters, stage, q, lex, "available");
  const sql = `
    SELECT available AS value, count(*)::int AS count
    FROM product_search_doc
    WHERE ${where}
    GROUP BY available`;
  const rows = await exec.rows<{ value: boolean; count: number }>(sql, pb.values);
  const opts: FacetOption[] = [];
  for (const r of rows) {
    opts.push({
      value: r.value ? "true" : "false",
      label: r.value ? "In stock" : "Out of stock",
      count: r.count,
    });
  }
  // Stable order: In stock first.
  return opts.sort((a, b) => (a.value === b.value ? 0 : a.value === "true" ? -1 : 1));
}

/** The one proof-of-concept metafield facet (single-value, exact-match). */
async function metafieldFacet(
  exec: Exec,
  shopId: string,
  versionId: string,
  q: string,
  filters: SearchFilters,
  matcher: Matcher,
): Promise<FacetOption[]> {
  const pb = new Params();
  const { stage, lex } = stageOf(matcher);
  const where = buildWhere(pb, shopId, versionId, filters, stage, q, lex, "metafield");
  const keyP = pb.add(FACET_METAFIELD_MAPKEY);
  const sql = `
    SELECT metafields->>${keyP} AS value, count(*)::int AS count
    FROM product_search_doc
    WHERE ${where} AND metafields->>${keyP} IS NOT NULL AND metafields->>${keyP} <> ''
    GROUP BY value
    ORDER BY count DESC, value ASC
    LIMIT ${FACET_OPTION_LIMIT}`;
  const rows = await exec.rows<{ value: string; count: number }>(sql, pb.values);
  return rows.map((r) => ({ value: r.value, label: r.value, count: r.count }));
}

/** Price range (min/max) over the set filtered by everything EXCEPT price. */
async function priceRange(
  exec: Exec,
  shopId: string,
  versionId: string,
  q: string,
  filters: SearchFilters,
  matcher: Matcher,
): Promise<{ min: string; max: string } | null> {
  const pb = new Params();
  const { stage, lex } = stageOf(matcher);
  const where = buildWhere(pb, shopId, versionId, filters, stage, q, lex, "price");
  const sql = `
    SELECT min(price_min) AS min, max(price_max) AS max
    FROM product_search_doc WHERE ${where}`;
  const rows = await exec.rows<{ min: string | null; max: string | null }>(sql, pb.values);
  const r = rows[0];
  if (!r || r.min == null || r.max == null) return null;
  return { min: String(r.min), max: String(r.max) };
}

/** Compute all facets + price range for a resolved matcher + filters. */
export async function computeFacetsWithExec(
  exec: Exec,
  shopId: string,
  versionId: string,
  q: string,
  filters: SearchFilters,
  matcher: Matcher,
): Promise<FacetsResult> {
  // Sequential: one tenant Exec == one DB client/transaction, which cannot run
  // concurrent queries (node-postgres). Each facet is a small indexed count.
  const vendor = await columnFacet(exec, shopId, versionId, q, filters, matcher, "vendor", "vendor");
  const productType = await columnFacet(exec, shopId, versionId, q, filters, matcher, "productType", "product_type");
  const tags = await tagsFacet(exec, shopId, versionId, q, filters, matcher);
  const availability = await availabilityFacet(exec, shopId, versionId, q, filters, matcher);
  const metafield = await metafieldFacet(exec, shopId, versionId, q, filters, matcher);
  const range = await priceRange(exec, shopId, versionId, q, filters, matcher);

  const facets: Facet[] = [
    { key: "vendor", label: "Vendor", options: vendor },
    { key: "productType", label: "Product type", options: productType },
    { key: "tags", label: "Tags", options: tags },
    { key: "available", label: "Availability", options: availability },
    { key: FACET_METAFIELD.key, label: FACET_METAFIELD.label, options: metafield },
  ].filter((f) => f.options.length > 0);

  return { facets, priceRange: range };
}
