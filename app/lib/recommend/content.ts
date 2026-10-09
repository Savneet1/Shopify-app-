import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import type { ProductRef } from "./refs";
import { partitionRefs } from "./refs";

/**
 * Phase 9.1 — content-based recommendations ("similar" / "related").
 *
 * Deterministic, rule-based, no ML / no embeddings / no randomness. Everything
 * is computed in ONE parameterised SQL statement from the ACTIVE index version's
 * VISIBLE docs (published = true AND status = 'ACTIVE') using only fields
 * already indexed in product_search_doc:
 *   - shared collections  (doc->'collections' titles, set-overlap, capped)
 *   - same product_type
 *   - same vendor
 *   - shared tags         (tags[] overlap, capped)
 *   - price-band proximity (relative distance of price_min)
 *   - title trigram similarity (pg_trgm similarity(), already installed Phase 3)
 *
 * The weighted sum is the score; results are ordered by score DESC with a fully
 * deterministic tie-break (title ASC, then product_id ASC). The seed(s) are
 * always excluded; out-of-stock products are excluded unless includeOutOfStock;
 * Phase 8 hidden products are never recommended (hideIds); an optional
 * per-vendor diversification cap limits how many items one vendor contributes.
 *
 * Reading ONLY the active-version visible docs means draft / deleted /
 * unpublished / other-shop products can never be recommended, and the engine
 * follows an index swap or rollback automatically (it always reads the version
 * id it is given — the caller passes the active one). An unknown / unpublished /
 * invalid seed resolves to zero seed rows and yields an EMPTY list — never an
 * error, never a leak.
 */

export type ContentKind = "similar" | "related";

/** Documented, exact weight profiles (no learned weights). */
export interface WeightProfile {
  wCollection: number;
  collectionCap: number;
  wType: number;
  wVendor: number;
  wTag: number;
  tagCap: number;
  wPrice: number;
  wTrgm: number;
}

export const WEIGHTS: Record<ContentKind, WeightProfile> = {
  // "similar" = near neighbours: title/price similarity matters most alongside
  // shared collections.
  similar: { wCollection: 40, collectionCap: 3, wType: 30, wVendor: 20, wTag: 10, tagCap: 3, wPrice: 15, wTrgm: 25 },
  // "related" = goes-with: shared collections + tags lead; near-identical title
  // and exact price are de-emphasised (a related item need not look the same).
  related: { wCollection: 50, collectionCap: 3, wType: 25, wVendor: 10, wTag: 20, tagCap: 4, wPrice: 5, wTrgm: 5 },
};

export const MAX_REC_LIMIT = 24;

export interface ContentCard {
  id: string;
  gid: string;
  title: string | null;
  handle: string | null;
  url: string | null;
  vendor: string | null;
  productType: string | null;
  image: { url: string | null; alt: string | null };
  priceMin: string | null;
  priceMax: string | null;
  compareAtMin: string | null;
  compareAtMax: string | null;
  available: boolean;
  score: number;
  /** Component breakdown for the admin "why is this here?" preview. */
  breakdown?: {
    collections: number;
    productType: number;
    vendor: number;
    tags: number;
    price: number;
    title: number;
  };
}

export interface ContentOptions {
  kind: ContentKind;
  limit: number;
  includeOutOfStock: boolean;
  /** 0 = off; otherwise max items per vendor in the returned list. */
  diversifyPerVendor: number;
  /** Phase 8 hidden product ids (never recommended). */
  hideIds: string[];
  /** Extra product ids to exclude (e.g. already-viewed in "recently viewed"). */
  excludeProductIds?: string[];
  /** Include the per-component score breakdown (admin preview). */
  explain?: boolean;
}

function clampLimit(n: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return v > MAX_REC_LIMIT ? MAX_REC_LIMIT : v;
}

/** The SQL fragment matching any of the resolved seed refs (typed arrays). */
function refMatchSql(pb: Params, refs: ProductRef[], idCol = "product_id", gidCol = "shopify_product_gid"): string {
  const { uuids, gids, handles } = partitionRefs(refs);
  const ors: string[] = [];
  if (uuids.length) ors.push(`${idCol} = ANY(${pb.add(uuids)}::uuid[])`);
  if (gids.length) ors.push(`${gidCol} = ANY(${pb.add(gids)}::text[])`);
  if (handles.length) ors.push(`doc->>'handle' = ANY(${pb.add(handles)}::text[])`);
  if (ors.length === 0) return "false"; // no valid refs → matches nothing
  return `(${ors.join(" OR ")})`;
}

function mapCard(row: any, explain: boolean): ContentCard {
  const d = row.doc ?? {};
  const img = d.image ?? {};
  const card: ContentCard = {
    id: row.product_id,
    gid: row.gid,
    title: d.title ?? null,
    handle: d.handle ?? null,
    url: d.url ?? null,
    vendor: d.vendor ?? null,
    productType: d.productType ?? null,
    image: { url: img.url ?? null, alt: img.alt ?? null },
    priceMin: d.priceMin != null ? String(d.priceMin) : null,
    priceMax: d.priceMax != null ? String(d.priceMax) : null,
    compareAtMin: d.compareAtMin != null ? String(d.compareAtMin) : null,
    compareAtMax: d.compareAtMax != null ? String(d.compareAtMax) : null,
    available: Boolean(d.available),
    score: Number(row.score),
  };
  if (explain) {
    card.breakdown = {
      collections: Number(row.s_col),
      productType: Number(row.s_type),
      vendor: Number(row.s_vendor),
      tags: Number(row.s_tag),
      price: Number(row.s_price),
      title: Number(row.s_trgm),
    };
  }
  return card;
}

/**
 * Resolve a set of refs to the internal product ids of the matching VISIBLE
 * docs in the active version, preserving the input order (used by
 * "recently viewed", which lists products in the order the shopper saw them).
 * Unresolved refs are simply absent from the result.
 */
export async function resolveRefsToProductIds(
  exec: Exec,
  shopId: string,
  versionId: string,
  refs: ProductRef[],
): Promise<string[]> {
  if (refs.length === 0) return [];
  const pb = new Params();
  const sid = pb.add(shopId);
  const vid = pb.add(versionId);
  const match = refMatchSql(pb, refs);
  const rows = await exec.rows<{ product_id: string; gid: string; handle: string | null }>(
    `SELECT product_id, shopify_product_gid AS gid, doc->>'handle' AS handle
     FROM product_search_doc
     WHERE shop_id = ${sid}::uuid AND index_version_id = ${vid}::uuid
       AND published = true AND status = 'ACTIVE' AND ${match}`,
    pb.values,
  );
  // Re-order by the refs' order (match by any of uuid/gid/handle).
  const byUuid = new Map(rows.map((r) => [r.product_id, r.product_id]));
  const byGid = new Map(rows.map((r) => [r.gid, r.product_id]));
  const byHandle = new Map(rows.filter((r) => r.handle).map((r) => [r.handle as string, r.product_id]));
  const ordered: string[] = [];
  const emitted = new Set<string>();
  for (const r of refs) {
    const pid =
      r.kind === "uuid" ? byUuid.get(r.value)
      : r.kind === "gid" ? byGid.get(r.value)
      : byHandle.get(r.value);
    if (pid && !emitted.has(pid)) {
      emitted.add(pid);
      ordered.push(pid);
    }
  }
  return ordered;
}

/**
 * Fetch visible-doc cards for an explicit, ordered list of product ids,
 * preserving that order (used by "recently viewed"). Out-of-stock excluded
 * unless includeOutOfStock; hidden ids always excluded.
 */
export async function cardsByProductIds(
  exec: Exec,
  shopId: string,
  versionId: string,
  productIds: string[],
  opts: { includeOutOfStock: boolean; hideIds: string[] },
): Promise<ContentCard[]> {
  if (productIds.length === 0) return [];
  const pb = new Params();
  const sid = pb.add(shopId);
  const vid = pb.add(versionId);
  const ids = pb.add(productIds);
  const parts = [
    `shop_id = ${sid}::uuid`,
    `index_version_id = ${vid}::uuid`,
    `published = true`,
    `status = 'ACTIVE'`,
    `product_id = ANY(${ids}::uuid[])`,
  ];
  if (!opts.includeOutOfStock) parts.push(`available = true`);
  if (opts.hideIds.length > 0) parts.push(`product_id <> ALL(${pb.add(opts.hideIds)}::uuid[])`);
  const rows = await exec.rows<any>(
    `SELECT product_id, shopify_product_gid AS gid, doc
     FROM product_search_doc WHERE ${parts.join(" AND ")}`,
    pb.values,
  );
  const byId = new Map(rows.map((r) => [r.product_id, r]));
  const out: ContentCard[] = [];
  for (const id of productIds) {
    const r = byId.get(id);
    if (r) out.push(mapCard(r, false));
  }
  return out;
}

/**
 * Content-based recommendations for one or more seed refs. Returns ranked cards
 * (empty when no seed resolves to a visible doc). `seedRefs` with more than one
 * entry sums the per-seed scores (used by "based on what you viewed").
 */
export async function recommendContent(
  exec: Exec,
  shopId: string,
  versionId: string,
  seedRefs: ProductRef[],
  opts: ContentOptions,
): Promise<ContentCard[]> {
  if (seedRefs.length === 0) return [];
  const w = WEIGHTS[opts.kind];
  const limit = clampLimit(opts.limit);
  const explain = opts.explain === true;

  const pb = new Params();
  const sid = pb.add(shopId);
  const vid = pb.add(versionId);
  const seedMatch = refMatchSql(pb, seedRefs);

  const candParts: string[] = [
    `d.shop_id = ${sid}::uuid`,
    `d.index_version_id = ${vid}::uuid`,
    `d.published = true`,
    `d.status = 'ACTIVE'`,
    // never recommend a seed back to itself
    `d.product_id NOT IN (SELECT seed_id FROM seeds)`,
  ];
  if (!opts.includeOutOfStock) candParts.push(`d.available = true`);
  if (opts.hideIds.length > 0) candParts.push(`d.product_id <> ALL(${pb.add(opts.hideIds)}::uuid[])`);
  if (opts.excludeProductIds && opts.excludeProductIds.length > 0) {
    candParts.push(`d.product_id <> ALL(${pb.add(opts.excludeProductIds)}::uuid[])`);
  }

  const pCollectionCap = pb.add(w.collectionCap);
  const pTagCap = pb.add(w.tagCap);
  const pWCol = pb.add(w.wCollection);
  const pWType = pb.add(w.wType);
  const pWVendor = pb.add(w.wVendor);
  const pWTag = pb.add(w.wTag);
  const pWPrice = pb.add(w.wPrice);
  const pWTrgm = pb.add(w.wTrgm);
  // Qualifying threshold: an item appears ONLY if it shares a real attribute
  // (collection/type/vendor/tag) OR its title is genuinely similar (trigram
  // similarity ≥ 0.3). Price proximity ALONE never qualifies an item — it only
  // refines the ordering among already-related items — so an unrelated product
  // that merely happens to cost about the same is not recommended.
  const pTrgmQualify = pb.add(w.wTrgm * 0.3);

  // Per-seed component expressions (summed over the seeds via the lateral).
  const scoreCte = `
    WITH seeds AS (
      SELECT product_id AS seed_id,
             title AS seed_title,
             vendor AS seed_vendor,
             product_type AS seed_type,
             tags AS seed_tags,
             price_min AS seed_price,
             ARRAY(SELECT jsonb_array_elements_text(doc->'collections')) AS seed_cols
      FROM product_search_doc
      WHERE shop_id = ${sid}::uuid AND index_version_id = ${vid}::uuid
        AND published = true AND status = 'ACTIVE' AND ${seedMatch}
    ),
    cand AS (
      SELECT d.product_id,
             d.shopify_product_gid AS gid,
             d.doc,
             d.title,
             d.vendor,
             d.product_type,
             d.tags,
             d.price_min,
             ARRAY(SELECT jsonb_array_elements_text(d.doc->'collections')) AS cols
      FROM product_search_doc d
      WHERE ${candParts.join(" AND ")}
    ),
    scored AS (
      SELECT c.product_id, c.gid, c.doc, c.title, c.vendor,
             sc.s_col, sc.s_type, sc.s_vendor, sc.s_tag, sc.s_price, sc.s_trgm,
             (sc.s_col + sc.s_type + sc.s_vendor + sc.s_tag + sc.s_price + sc.s_trgm) AS score
      FROM cand c
      CROSS JOIN LATERAL (
        SELECT
          COALESCE(SUM(
            LEAST(cardinality(ARRAY(SELECT unnest(c.cols) INTERSECT SELECT unnest(s.seed_cols))), ${pCollectionCap}::int) * ${pWCol}::numeric
          ), 0) AS s_col,
          COALESCE(SUM(
            CASE WHEN c.product_type IS NOT NULL AND c.product_type = s.seed_type THEN ${pWType}::numeric ELSE 0 END
          ), 0) AS s_type,
          COALESCE(SUM(
            CASE WHEN c.vendor IS NOT NULL AND c.vendor = s.seed_vendor THEN ${pWVendor}::numeric ELSE 0 END
          ), 0) AS s_vendor,
          COALESCE(SUM(
            LEAST(cardinality(ARRAY(SELECT unnest(c.tags) INTERSECT SELECT unnest(s.seed_tags))), ${pTagCap}::int) * ${pWTag}::numeric
          ), 0) AS s_tag,
          COALESCE(SUM(
            ${pWPrice}::numeric * GREATEST(0, 1 - LEAST(
              CASE WHEN s.seed_price IS NULL OR c.price_min IS NULL THEN 1
                   ELSE abs(c.price_min - s.seed_price) / GREATEST(s.seed_price, 1) END, 1))
          ), 0) AS s_price,
          COALESCE(SUM(
            ${pWTrgm}::numeric * COALESCE(similarity(c.title, s.seed_title), 0)
          ), 0) AS s_trgm
        FROM seeds s
      ) sc
    )`;

  let sql: string;
  if (opts.diversifyPerVendor && opts.diversifyPerVendor > 0) {
    const pCap = pb.add(Math.floor(opts.diversifyPerVendor));
    const pLimit = pb.add(limit);
    sql = `${scoreCte}
      , ranked AS (
        SELECT *, row_number() OVER (PARTITION BY vendor ORDER BY score DESC, title ASC, product_id ASC) AS rn
        FROM scored
        WHERE (s_col + s_type + s_vendor + s_tag) > 0 OR s_trgm >= ${pTrgmQualify}::numeric
      )
      SELECT product_id, gid, doc, s_col, s_type, s_vendor, s_tag, s_price, s_trgm, score
      FROM ranked
      WHERE vendor IS NULL OR rn <= ${pCap}::int
      ORDER BY score DESC, title ASC, product_id ASC
      LIMIT ${pLimit}::int`;
  } else {
    const pLimit = pb.add(limit);
    sql = `${scoreCte}
      SELECT product_id, gid, doc, s_col, s_type, s_vendor, s_tag, s_price, s_trgm, score
      FROM scored
      WHERE (s_col + s_type + s_vendor + s_tag) > 0 OR s_trgm >= ${pTrgmQualify}::numeric
      ORDER BY score DESC, title ASC, product_id ASC
      LIMIT ${pLimit}::int`;
  }

  const rows = await exec.rows<any>(sql, pb.values);
  return rows.map((r) => mapCard(r, explain));
}
