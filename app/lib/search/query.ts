import type { Exec } from "~/lib/db/executor";
import { withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";
import {
  Params,
  type SearchFilters,
  type RawFilters,
  normalizeFilters,
  visibilityPredicate,
  collectionPredicate,
  filterPredicates,
  skuHitPredicate,
  ftsPredicate,
  rankExpr,
  queryTokens,
  prefixLexemes,
  orLexemes,
  type Strategy,
} from "./filters";

/**
 * Storefront full-text search over the ACTIVE index version, now with Phase 4
 * filtering. Guarantees are unchanged from Phase 3 (ACTIVE-version-only,
 * published+ACTIVE visibility, parameterised/sanitised tsqueries, bounded
 * length/limit/offset, per-statement timeout, cascade AND→prefix→OR→trigram with
 * exact SKU/barcode first, ts_rank_cd baseline). Filters and the shared
 * visibility predicate come from ./filters so search and facets never diverge.
 *
 * When `q` is empty but filters/collection are present, the engine runs in
 * "browse" mode: no text predicate, just the filter set — the collection-page /
 * filter-only case.
 */

export const MAX_QUERY_LEN = 200;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 24;
export const MAX_OFFSET = 1000;
const STATEMENT_TIMEOUT_MS = Number(process.env.SEARCH_STATEMENT_TIMEOUT_MS || 3000);

export type SearchStrategy = Strategy;
export { queryTokens };

export interface SearchParams {
  q: string;
  limit?: number;
  offset?: number;
  filters?: RawFilters;
}

export interface SearchProduct {
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
}

export interface SearchResponse {
  products: SearchProduct[];
  total: number;
  strategy: SearchStrategy;
  indexVersion: number | null;
  tookMs: number;
  fallback?: "native";
}

export function normalizeParams(p: SearchParams): { q: string; limit: number; offset: number } {
  const q = String(p.q ?? "").slice(0, MAX_QUERY_LEN).trim();
  let limit = Number.isFinite(p.limit) ? Math.floor(Number(p.limit)) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);
  let offset = Number.isFinite(p.offset) ? Math.floor(Number(p.offset)) : 0;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  offset = Math.min(offset, MAX_OFFSET);
  return { q, limit, offset };
}

function mapDocToProduct(row: { product_id: string; gid: string; doc: any }): SearchProduct {
  const d = row.doc ?? {};
  const img = d.image ?? {};
  return {
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
  };
}

export type Stage = Exclude<Strategy, "browse" | "exact_sku" | "none">;

/** Ordered broadening stages available for the token set. */
function stagesFor(tokens: string[]): Stage[] {
  const s: Stage[] = ["and"];
  if (prefixLexemes(tokens)) s.push("prefix");
  if (orLexemes(tokens)) s.push("or");
  s.push("trigram");
  return s;
}

function lexFor(stage: Stage, tokens: string[]): string | null {
  return stage === "prefix" ? prefixLexemes(tokens) : stage === "or" ? orLexemes(tokens) : null;
}

/**
 * Build the full WHERE (visibility + collection + filters + optional text match)
 * into `pb`. When `stage` is null (browse mode) there is no text predicate.
 * `exclude` drops one facet group (used by facet counting).
 */
export function buildWhere(
  pb: Params,
  shopId: string,
  versionId: string,
  filters: SearchFilters,
  stage: Stage | null,
  q: string,
  lex: string | null,
  exclude?: Parameters<typeof filterPredicates>[2],
): string {
  const parts = [visibilityPredicate(pb, shopId, versionId)];
  const col = collectionPredicate(pb, shopId, filters.collectionId);
  if (col) parts.push(col);
  for (const p of filterPredicates(pb, filters, exclude)) parts.push(p);
  if (stage) parts.push(`((${ftsPredicate(pb, stage, q, lex)}) OR (${skuHitPredicate(pb, q)}))`);
  return parts.join(" AND ");
}

export type Matcher = { kind: "browse" } | { kind: "stage"; stage: Stage; lex: string | null };

/** Probe stages in order; the first that yields any row (under all filters) wins.
 * q-empty → browse. Nothing matched → null. Exposed so facets reuse the winner. */
export async function resolveMatcher(
  exec: Exec,
  shopId: string,
  versionId: string,
  q: string,
  tokens: string[],
  filters: SearchFilters,
): Promise<Matcher | null> {
  if (q.length === 0) return { kind: "browse" };
  for (const stage of stagesFor(tokens)) {
    const lex = lexFor(stage, tokens);
    const pb = new Params();
    const where = buildWhere(pb, shopId, versionId, filters, stage, q, lex);
    const rows = await exec.rows(`SELECT 1 FROM product_search_doc WHERE ${where} LIMIT 1`, pb.values);
    if (rows.length) return { kind: "stage", stage, lex };
  }
  return null;
}

interface ProductRow {
  product_id: string;
  gid: string;
  doc: any;
  total: number;
  fts_total: number;
  sku_total: number;
}

/** Run the product page for a resolved matcher + filters. */
export async function runProducts(
  exec: Exec,
  shopId: string,
  versionId: string,
  matcher: Matcher,
  q: string,
  filters: SearchFilters,
  limit: number,
  offset: number,
): Promise<{ rows: ProductRow[] }> {
  const pb = new Params();
  const stage = matcher.kind === "stage" ? matcher.stage : null;
  const lex = matcher.kind === "stage" ? matcher.lex : null;
  const where = buildWhere(pb, shopId, versionId, filters, stage, q, lex);
  const skuSel = stage ? skuHitPredicate(pb, q) : "false";
  const rankSel = stage ? rankExpr(pb, stage, q, lex) : "0";
  const ftsSel = stage ? ftsPredicate(pb, stage, q, lex) : "true";
  const limP = pb.add(limit);
  const offP = pb.add(offset);
  const sql = `
    WITH base AS (
      SELECT product_id, shopify_product_gid AS gid, doc, title,
             (${skuSel}) AS sku_hit, (${rankSel}) AS rank, (${ftsSel}) AS fts_hit
      FROM product_search_doc WHERE ${where}
    )
    SELECT b.product_id, b.gid, b.doc,
           (SELECT count(*)::int FROM base) AS total,
           (SELECT count(*)::int FROM base WHERE fts_hit) AS fts_total,
           (SELECT count(*)::int FROM base WHERE sku_hit) AS sku_total
    FROM base b
    ORDER BY b.sku_hit DESC, b.rank DESC NULLS LAST, b.title ASC
    LIMIT ${limP}::int OFFSET ${offP}::int`;
  const rows = await exec.rows<ProductRow>(sql, pb.values);
  return { rows };
}

/**
 * Full search over an existing tenant Exec. Contains the no-active-index guard;
 * validation errors from filters propagate to the caller (mapped to 400).
 */
export async function searchWithExec(
  exec: Exec,
  shopId: string,
  params: SearchParams,
): Promise<SearchResponse> {
  const started = Date.now();
  const { q, limit, offset } = normalizeParams(params);
  const filters = normalizeFilters(params.filters);

  const timeout = Math.max(100, Math.min(STATEMENT_TIMEOUT_MS, 10000));
  await exec.run(`SET LOCAL statement_timeout = ${timeout}`);

  const active = await getActiveVersion(exec, shopId);
  if (!active) {
    return { products: [], total: 0, strategy: "none", indexVersion: null, tookMs: Date.now() - started, fallback: "native" };
  }

  const empty = (strategy: SearchStrategy): SearchResponse => ({
    products: [], total: 0, strategy, indexVersion: active.version, tookMs: Date.now() - started,
  });

  // q empty -> browse mode (all visible, optionally filtered).
  const tokens = queryTokens(q);
  const matcher = await resolveMatcher(exec, shopId, active.id, q, tokens, filters);
  if (!matcher) return empty("none"); // q present, nothing matched at any stage

  const { rows } = await runProducts(exec, shopId, active.id, matcher, q, filters, limit, offset);
  const total = rows[0]?.total ?? 0;
  const ftsTotal = rows[0]?.fts_total ?? 0;
  const skuTotal = rows[0]?.sku_total ?? 0;
  let strategy: SearchStrategy =
    matcher.kind === "browse" ? "browse" : matcher.stage;
  if (matcher.kind === "stage" && ftsTotal === 0 && skuTotal > 0) strategy = "exact_sku";

  return {
    products: rows.map(mapDocToProduct),
    total,
    strategy,
    indexVersion: active.version,
    tookMs: Date.now() - started,
  };
}

export async function searchProducts(shopId: string, params: SearchParams): Promise<SearchResponse> {
  const started = Date.now();
  try {
    return await withShopExec(shopId, (exec) => searchWithExec(exec, shopId, params));
  } catch {
    return { products: [], total: 0, strategy: "none", indexVersion: null, tookMs: Date.now() - started, fallback: "native" };
  }
}
