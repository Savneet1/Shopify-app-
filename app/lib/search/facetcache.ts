import type { Exec } from "~/lib/db/executor";
import { FACET_METAFIELD, FACET_METAFIELD_MAPKEY } from "./config";
import type { Facet, FacetOption, FacetsResult } from "./facets";

/**
 * Phase 14b P3/P4 — per-index-version precomputed facet values + summary.
 *
 * Rebuilt from the version's VISIBLE docs (published + status ACTIVE) by
 * rebuildVocabulary, i.e. after EVERY doc-writing path (full build, incremental
 * refresh, activation catch-up, collection-member refresh, reindex) — so it
 * always matches the docs of its version and follows the atomic swap / rollback
 * (keyed by index_version_id, ON DELETE CASCADE for retention). A combined-parent
 * doc refresh rewrites only the doc JSON aggregate, never the facet COLUMNS
 * (vendor/type/tags/price/metafields/available are the parent's own), so it
 * cannot change these counts.
 *
 * The stored rows reproduce the LIVE facet/NL-context SQL exactly:
 *  - vendor/product_type/metafield: WHERE value IS NOT NULL AND value <> ''
 *  - tag: unnest(tags) (keeps '' to match the live tags facet; NL context drops
 *    '' in TS exactly as it did for the live DISTINCT)
 *  - available: GROUP BY available → true/false counts
 *  - summary: min(price_min)/max(price_max)/count(*) over visible docs
 */

const VISIBLE = `shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'`;

/** Recompute the precomputed facet tables for one index version from its docs. */
export async function rebuildFacetPrecompute(exec: Exec, shopId: string, versionId: string): Promise<void> {
  await exec.run(`DELETE FROM search_facet_value WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`, [shopId, versionId]);
  await exec.run(
    `INSERT INTO search_facet_value (shop_id, index_version_id, kind, value, doc_count)
       SELECT $1::uuid,$2::uuid,'vendor', vendor, count(*)::int
         FROM product_search_doc WHERE ${VISIBLE} AND vendor IS NOT NULL AND vendor <> '' GROUP BY vendor
       UNION ALL
       SELECT $1::uuid,$2::uuid,'product_type', product_type, count(*)::int
         FROM product_search_doc WHERE ${VISIBLE} AND product_type IS NOT NULL AND product_type <> '' GROUP BY product_type
       UNION ALL
       SELECT $1::uuid,$2::uuid,'tag', t, count(*)::int
         FROM product_search_doc psd, unnest(psd.tags) AS t
         WHERE psd.shop_id=$1::uuid AND psd.index_version_id=$2::uuid AND psd.published=true AND psd.status='ACTIVE'
           AND t IS NOT NULL GROUP BY t
       UNION ALL
       SELECT $1::uuid,$2::uuid,'metafield', metafields->>$3, count(*)::int
         FROM product_search_doc WHERE ${VISIBLE} AND metafields->>$3 IS NOT NULL AND metafields->>$3 <> '' GROUP BY metafields->>$3
       UNION ALL
       SELECT $1::uuid,$2::uuid,'available', CASE WHEN available THEN 'true' ELSE 'false' END, count(*)::int
         FROM product_search_doc WHERE ${VISIBLE} GROUP BY available`,
    [shopId, versionId, FACET_METAFIELD_MAPKEY],
  );
  await exec.run(`DELETE FROM search_facet_summary WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`, [shopId, versionId]);
  await exec.run(
    `INSERT INTO search_facet_summary (shop_id, index_version_id, price_min, price_max, doc_count)
       SELECT $1::uuid,$2::uuid, min(price_min), max(price_max), count(*)::int
       FROM product_search_doc WHERE ${VISIBLE}`,
    [shopId, versionId],
  );
}

/**
 * P2: rebuild the per-version suggestion terms from the version's VISIBLE docs,
 * extracting EXACTLY the same term set the live suggestion query produces —
 * titles, vendors, product types and (version-snapshot) collection titles — so a
 * no-hide/show_all request can prefix-match a small indexed table instead of
 * scanning every doc. Stored distinct per (type, text); '' excluded (the live
 * query filters text <> '').
 */
export async function rebuildSuggestTerms(exec: Exec, shopId: string, versionId: string): Promise<void> {
  await exec.run(`DELETE FROM search_suggest_term WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`, [shopId, versionId]);
  // Phase 14c: doc_count = number of visible docs contributing each (type,text),
  // so the term can be delta-maintained (+/-1, delete at 0). Reads ignore it, so
  // suggestions stay byte-identical. '' is filtered inline (was a post-DELETE).
  await exec.run(
    `INSERT INTO search_suggest_term (shop_id, index_version_id, type, text, doc_count)
       SELECT $1::uuid,$2::uuid,'title', title, count(*)::int FROM product_search_doc
         WHERE ${VISIBLE} AND title IS NOT NULL AND title <> '' GROUP BY title
       UNION ALL
       SELECT $1::uuid,$2::uuid,'vendor', doc->>'vendor', count(*)::int FROM product_search_doc
         WHERE ${VISIBLE} AND doc->>'vendor' IS NOT NULL AND doc->>'vendor' <> '' GROUP BY doc->>'vendor'
       UNION ALL
       SELECT $1::uuid,$2::uuid,'productType', doc->>'productType', count(*)::int FROM product_search_doc
         WHERE ${VISIBLE} AND doc->>'productType' IS NOT NULL AND doc->>'productType' <> '' GROUP BY doc->>'productType'
       UNION ALL
       SELECT $1::uuid,$2::uuid,'collection', ct, count(*)::int
         FROM product_search_doc psd, jsonb_array_elements_text(psd.doc->'collections') AS ct
         WHERE psd.shop_id=$1::uuid AND psd.index_version_id=$2::uuid AND psd.published=true AND psd.status='ACTIVE'
           AND jsonb_typeof(psd.doc->'collections') = 'array' AND ct IS NOT NULL AND ct <> '' GROUP BY ct`,
    [shopId, versionId],
  );
}

/** P3: distinct visible facet values per kind for the NL parse context. */
export async function precomputedParseValues(
  exec: Exec, shopId: string, versionId: string,
): Promise<{ vendors: string[]; productTypes: string[]; tagValues: string[]; metafieldValues: string[] }> {
  const rows = await exec.rows<{ kind: string; value: string }>(
    `SELECT kind, value FROM search_facet_value
     WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
       AND kind IN ('vendor','product_type','tag','metafield')
     ORDER BY kind, value`,
    [shopId, versionId],
  );
  const by = (k: string) => rows.filter((r) => r.kind === k).map((r) => r.value);
  return {
    vendors: by("vendor"),
    productTypes: by("product_type"),
    // '' is kept in the table (to match the live tags facet); NL context drops it
    // exactly as the live DISTINCT query's TS filter did.
    tagValues: by("tag").filter((v) => v != null && v !== ""),
    metafieldValues: by("metafield"),
  };
}

const FACET_OPTION_LIMIT = 50;

/** P4: assemble the unfiltered-browse FacetsResult from the precomputed tables. */
export async function precomputedFacets(exec: Exec, shopId: string, versionId: string): Promise<FacetsResult> {
  // Column facets: top-50 by count desc, value asc — identical to the live query.
  const opts = async (kind: string): Promise<FacetOption[]> => {
    const rows = await exec.rows<{ value: string; doc_count: number }>(
      `SELECT value, doc_count FROM search_facet_value
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND kind=$3
       ORDER BY doc_count DESC, value ASC LIMIT ${FACET_OPTION_LIMIT}`,
      [shopId, versionId, kind],
    );
    return rows.map((r) => ({ value: r.value, label: r.value, count: Number(r.doc_count) }));
  };
  const vendor = await opts("vendor");
  const productType = await opts("product_type");
  const tags = await opts("tag");
  const metafield = await opts("metafield");

  // Availability: true/false counts → in-stock-first, matching the live facet.
  const avRows = await exec.rows<{ value: string; doc_count: number }>(
    `SELECT value, doc_count FROM search_facet_value
     WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND kind='available'`,
    [shopId, versionId],
  );
  const availability: FacetOption[] = avRows
    .map((r) => ({ value: r.value, label: r.value === "true" ? "In stock" : "Out of stock", count: Number(r.doc_count) }))
    .sort((a, b) => (a.value === b.value ? 0 : a.value === "true" ? -1 : 1));

  const facets: Facet[] = [
    { key: "vendor", label: "Vendor", options: vendor },
    { key: "productType", label: "Product type", options: productType },
    { key: "tags", label: "Tags", options: tags },
    { key: "available", label: "Availability", options: availability },
    { key: FACET_METAFIELD.key, label: FACET_METAFIELD.label, options: metafield },
  ].filter((f) => f.options.length > 0);

  // Price range: delta-maintained when clean; when a write may have dropped an
  // extreme we fall back to the live min/max (always exact) until reconcile
  // recomputes and clears price_dirty. This keeps the READ byte-identical.
  const sum = await exec.rows<{ min: string | null; max: string | null; dirty: boolean }>(
    `SELECT price_min AS min, price_max AS max, price_dirty AS dirty FROM search_facet_summary
     WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`,
    [shopId, versionId],
  );
  const r = sum[0];
  let priceRange: { min: string; max: string } | null = null;
  if (r && r.dirty) {
    const live = await exec.rows<{ min: string | null; max: string | null }>(
      `SELECT min(price_min) AS min, max(price_max) AS max FROM product_search_doc WHERE ${VISIBLE}`,
      [shopId, versionId],
    );
    const l = live[0];
    priceRange = l && l.min != null && l.max != null ? { min: String(l.min), max: String(l.max) } : null;
  } else if (r && r.min != null && r.max != null) {
    priceRange = { min: String(r.min), max: String(r.max) };
  }

  return { facets, priceRange };
}
