import type { Exec } from "~/lib/db/executor";
import { withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";
import {
  Params,
  type SearchFilters,
  type RawFilters,
  normalizeFilters,
} from "./filters";
import { buildWhere, skuHitPredicate, type PlannedMatch, type PlanLevel } from "./match";
import { buildPlan, andLex, prefixLex, orLex, fuzzyLex, type QueryPlan } from "./rewrite";
import {
  CLASS_WEIGHT,
  FIELD_SCALE,
  IN_STOCK_BOOST,
  fieldScoreSql,
  toTsQuery,
  type MatchClass,
} from "./ranking";

/**
 * Storefront search over the ACTIVE index version. Phase 5 adds a query planner
 * (stop words → typo correction → synonym expansion) and rule-based ranking on
 * top of the Phase 3/4 engine. The plan drives both products and facets (via
 * match.ts) so facet counts never drift. Guarantees unchanged: ACTIVE-version
 * only, published+ACTIVE visibility, parameterised/sanitised tsqueries, bounded
 * length/limit/offset, per-statement timeout.
 */

export const MAX_QUERY_LEN = 200;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 24;
export const MAX_OFFSET = 1000;
const STATEMENT_TIMEOUT_MS = Number(process.env.SEARCH_STATEMENT_TIMEOUT_MS || 3000);

export type SearchStrategy =
  | "browse" | "exact_sku" | "exact" | "prefix" | "synonym" | "fuzzy" | "partial" | "none";

export type SortOption = "relevance" | "price_asc" | "price_desc" | "newest";
export const SORT_OPTIONS: readonly SortOption[] = ["relevance", "price_asc", "price_desc", "newest"];
export function normalizeSort(v: unknown): SortOption {
  return SORT_OPTIONS.includes(v as SortOption) ? (v as SortOption) : "relevance";
}

export interface SearchParams {
  q: string;
  limit?: number;
  offset?: number;
  filters?: RawFilters;
  sort?: SortOption;
}

export interface Correction {
  from: string;
  to: string;
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
  matchClass?: MatchClass;
  score?: number;
}

export interface SearchResponse {
  products: SearchProduct[];
  total: number;
  strategy: SearchStrategy;
  indexVersion: number | null;
  tookMs: number;
  fallback?: "native";
  corrected: boolean;
  corrections: Correction[];
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

function mapDocToProduct(row: {
  product_id: string; gid: string; doc: any; cls?: MatchClass; score?: number;
}): SearchProduct {
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
    matchClass: row.cls,
    score: row.score != null ? Number(row.score) : undefined,
  };
}

/** Resolve the plan level: browse (empty), else the narrowest level that yields
 * a result under the filters (primary → partial), else null (nothing matched). */
export async function resolvePlanned(
  exec: Exec,
  shopId: string,
  versionId: string,
  plan: QueryPlan,
  filters: SearchFilters,
): Promise<PlannedMatch | null> {
  if (plan.isEmpty) return { plan, level: "browse" };
  for (const level of ["primary", "partial"] as PlanLevel[]) {
    const m: PlannedMatch = { plan, level };
    const pb = new Params();
    const where = buildWhere(pb, shopId, versionId, filters, m);
    const rows = await exec.rows(`SELECT 1 FROM product_search_doc WHERE ${where} LIMIT 1`, pb.values);
    if (rows.length) return m;
  }
  return null;
}

interface ProductRow {
  product_id: string;
  gid: string;
  doc: any;
  cls: MatchClass;
  score: number;
  total: number;
}

/** All lexemes involved (tokens + fuzzy candidates + synonym tokens), for the
 * field-score tsquery so ranking reflects any matched weighted lexeme. */
function rankLex(plan: QueryPlan): string {
  const set = new Set<string>(plan.keptTokens);
  for (const p of plan.positions) for (const c of p.candidates) set.add(c);
  for (const e of plan.synonymExpansions) for (const t of e) set.add(t);
  return orLex([...set]);
}

/** Run the ranked product page for a resolved plan + filters. */
export async function runProducts(
  exec: Exec,
  shopId: string,
  versionId: string,
  m: PlannedMatch,
  filters: SearchFilters,
  limit: number,
  offset: number,
  sort: SortOption = "relevance",
): Promise<{ rows: ProductRow[] }> {
  const pb = new Params();
  const where = buildWhere(pb, shopId, versionId, filters, m);
  const plan = m.plan;
  const hasTokens = plan.keptTokens.length > 0 && m.level !== "browse";

  // Per-row match-class flags + rule-based score.
  let clsExpr = `'browse'::text`;
  let scoreExpr = `0::float8`;
  if (hasTokens) {
    const sku = skuHitPredicate(pb, plan.raw);
    const exactQ = `tsv @@ ${toTsQuery(pb.add(andLex(plan.keptTokens)))}`;
    const prefixQ = `tsv @@ ${toTsQuery(pb.add(prefixLex(plan.keptTokens)))}`;
    const synParts = plan.synonymExpansions.map((e) => `tsv @@ ${toTsQuery(pb.add(andLex(e)))}`);
    const synQ = synParts.length ? `(${synParts.join(" OR ")})` : `false`;
    const fl = fuzzyLex(plan.positions);
    const fuzzyQ = fl ? `tsv @@ ${toTsQuery(pb.add(fl))}` : `false`;
    const rankQ = toTsQuery(pb.add(rankLex(plan)));
    clsExpr = `CASE
      WHEN ${sku} THEN 'sku'
      WHEN ${exactQ} THEN 'exact'
      WHEN ${prefixQ} THEN 'prefix'
      WHEN ${synQ} THEN 'synonym'
      WHEN ${fuzzyQ} THEN 'fuzzy'
      ELSE 'partial' END`;
    const classWeight = `CASE
      WHEN ${sku} THEN ${CLASS_WEIGHT.sku}
      WHEN ${exactQ} THEN ${CLASS_WEIGHT.exact}
      WHEN ${prefixQ} THEN ${CLASS_WEIGHT.prefix}
      WHEN ${synQ} THEN ${CLASS_WEIGHT.synonym}
      WHEN ${fuzzyQ} THEN ${CLASS_WEIGHT.fuzzy}
      ELSE ${CLASS_WEIGHT.partial} END`;
    scoreExpr = `(${classWeight}) + (${fieldScoreSql(rankQ)} * ${FIELD_SCALE})
      + (CASE WHEN available THEN ${IN_STOCK_BOOST} ELSE 0 END)`;
  }

  // Sort hints (Phase 6). Relevance (default) uses the rule-based score; the
  // others are deterministic column orders with a stable product-id tie-break.
  // NULLS LAST so missing price / createdAt never float to the top.
  const orderBy =
    sort === "price_asc" ? `b.price_min ASC NULLS LAST, b.pid ASC`
    : sort === "price_desc" ? `b.price_max DESC NULLS LAST, b.pid ASC`
    : sort === "newest" ? `b.created_at_shopify DESC NULLS LAST, b.pid ASC`
    : `b.score DESC, b.title ASC, b.pid ASC`;

  const limP = pb.add(limit);
  const offP = pb.add(offset);
  const sql = `
    WITH base AS (
      SELECT product_id, shopify_product_gid AS gid, doc, title, available, product_id AS pid,
             price_min, price_max, created_at_shopify,
             (${clsExpr}) AS cls,
             (${scoreExpr}) AS score
      FROM product_search_doc WHERE ${where}
    )
    SELECT b.product_id, b.gid, b.doc, b.cls, b.score,
           (SELECT count(*)::int FROM base) AS total
    FROM base b
    ORDER BY ${orderBy}
    LIMIT ${limP}::int OFFSET ${offP}::int`;
  const rows = await exec.rows<ProductRow>(sql, pb.values);
  return { rows };
}

/** Map a resolved plan/level + top row to the response strategy label. */
export function strategyOf(m: PlannedMatch | null, topClass: MatchClass | undefined, total: number): SearchStrategy {
  if (!m) return "none";
  if (m.level === "browse") return "browse";
  if (total === 0) return "none";
  if (topClass === "sku") return "exact_sku";
  return (topClass ?? (m.level === "partial" ? "partial" : "exact")) as SearchStrategy;
}

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
  const emptyBase = {
    products: [] as SearchProduct[], total: 0, tookMs: 0,
    corrected: false, corrections: [] as Correction[],
  };
  if (!active) {
    return { ...emptyBase, strategy: "none", indexVersion: null, tookMs: Date.now() - started, fallback: "native" };
  }

  const plan = await buildPlan(exec, shopId, active.id, q);
  const planned = await resolvePlanned(exec, shopId, active.id, plan, filters);
  const corrections = plan.corrections;

  if (!planned) {
    return { ...emptyBase, strategy: "none", indexVersion: active.version, tookMs: Date.now() - started, corrections, corrected: false };
  }

  const { rows } = await runProducts(exec, shopId, active.id, planned, filters, limit, offset, normalizeSort(params.sort));
  const total = rows[0]?.total ?? 0;
  const topClass = rows[0]?.cls;
  const strategy = strategyOf(planned, topClass, total);
  // A correction is "applied" only when the corrected terms actually drove
  // matches (fuzzy class present or nothing exact) — but we surface the
  // suggestion whenever the planner produced one and results exist.
  const corrected = corrections.length > 0 && total > 0;

  return {
    products: rows.map(mapDocToProduct),
    total,
    strategy,
    indexVersion: active.version,
    tookMs: Date.now() - started,
    corrected,
    corrections,
  };
}

export async function searchProducts(shopId: string, params: SearchParams): Promise<SearchResponse> {
  const started = Date.now();
  try {
    return await withShopExec(shopId, (exec) => searchWithExec(exec, shopId, params));
  } catch {
    return {
      products: [], total: 0, strategy: "none", indexVersion: null,
      tookMs: Date.now() - started, fallback: "native", corrected: false, corrections: [],
    };
  }
}
