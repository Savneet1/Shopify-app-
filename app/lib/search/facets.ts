import type { Exec } from "~/lib/db/executor";
import { Params, type SearchFilters } from "./filters";
import { buildWhere, type PlannedMatch } from "./match";
import { FACET_METAFIELD, FACET_METAFIELD_MAPKEY } from "./config";

/**
 * Phase 4.2 facet counting, Phase 5-aware. Each facet is a separate GROUP BY
 * count with the facet's OWN filter group EXCLUDED (so an option never zeroes
 * its own facet), while the shared text match (the SAME PlannedMatch used by the
 * product query — including fuzzy correction, synonym expansion and stop-word
 * removal), collection scope and visibility all still apply. Counts therefore
 * always match the result set. Every value is a bound parameter.
 */

export interface FacetOption { value: string; label: string; count: number; }
export interface Facet { key: string; label: string; options: FacetOption[]; }
export interface FacetsResult {
  facets: Facet[];
  priceRange: { min: string; max: string } | null;
}

const FACET_OPTION_LIMIT = 50;

async function columnFacet(
  exec: Exec, shopId: string, versionId: string, filters: SearchFilters, m: PlannedMatch,
  group: Parameters<typeof buildWhere>[5], column: string,
): Promise<FacetOption[]> {
  const pb = new Params();
  const where = buildWhere(pb, shopId, versionId, filters, m, group);
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

async function tagsFacet(
  exec: Exec, shopId: string, versionId: string, filters: SearchFilters, m: PlannedMatch,
): Promise<FacetOption[]> {
  const pb = new Params();
  const where = buildWhere(pb, shopId, versionId, filters, m, "tags");
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

async function availabilityFacet(
  exec: Exec, shopId: string, versionId: string, filters: SearchFilters, m: PlannedMatch,
): Promise<FacetOption[]> {
  const pb = new Params();
  const where = buildWhere(pb, shopId, versionId, filters, m, "available");
  const rows = await exec.rows<{ value: boolean; count: number }>(
    `SELECT available AS value, count(*)::int AS count FROM product_search_doc WHERE ${where} GROUP BY available`,
    pb.values,
  );
  return rows
    .map((r) => ({ value: r.value ? "true" : "false", label: r.value ? "In stock" : "Out of stock", count: r.count }))
    .sort((a, b) => (a.value === b.value ? 0 : a.value === "true" ? -1 : 1));
}

async function metafieldFacet(
  exec: Exec, shopId: string, versionId: string, filters: SearchFilters, m: PlannedMatch,
): Promise<FacetOption[]> {
  const pb = new Params();
  const where = buildWhere(pb, shopId, versionId, filters, m, "metafield");
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

async function priceRange(
  exec: Exec, shopId: string, versionId: string, filters: SearchFilters, m: PlannedMatch,
): Promise<{ min: string; max: string } | null> {
  const pb = new Params();
  const where = buildWhere(pb, shopId, versionId, filters, m, "price");
  const rows = await exec.rows<{ min: string | null; max: string | null }>(
    `SELECT min(price_min) AS min, max(price_max) AS max FROM product_search_doc WHERE ${where}`,
    pb.values,
  );
  const r = rows[0];
  if (!r || r.min == null || r.max == null) return null;
  return { min: String(r.min), max: String(r.max) };
}

export async function computeFacetsWithExec(
  exec: Exec, shopId: string, versionId: string, filters: SearchFilters, m: PlannedMatch,
): Promise<FacetsResult> {
  // Sequential (one tenant Exec == one client; no concurrent queries).
  const vendor = await columnFacet(exec, shopId, versionId, filters, m, "vendor", "vendor");
  const productType = await columnFacet(exec, shopId, versionId, filters, m, "productType", "product_type");
  const tags = await tagsFacet(exec, shopId, versionId, filters, m);
  const availability = await availabilityFacet(exec, shopId, versionId, filters, m);
  const metafield = await metafieldFacet(exec, shopId, versionId, filters, m);
  const range = await priceRange(exec, shopId, versionId, filters, m);

  const facets: Facet[] = [
    { key: "vendor", label: "Vendor", options: vendor },
    { key: "productType", label: "Product type", options: productType },
    { key: "tags", label: "Tags", options: tags },
    { key: "available", label: "Availability", options: availability },
    { key: FACET_METAFIELD.key, label: FACET_METAFIELD.label, options: metafield },
  ].filter((f) => f.options.length > 0);

  return { facets, priceRange: range };
}
