import type { Exec } from "~/lib/db/executor";
import { withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";
import {
  normalizeParams,
  resolveMatcher,
  runProducts,
  type SearchProduct,
  type SearchStrategy,
  type SearchParams,
} from "./query";
import {
  normalizeFilters,
  queryTokens,
  FilterValidationError,
  type SearchFilters,
} from "./filters";
import { computeFacetsWithExec, type Facet } from "./facets";
import { catalogSuggestionsWithExec, type Suggestion } from "./suggest";

/**
 * Storefront-facing orchestrator (Phase 3 fallback contract + Phase 4 facets).
 *
 * Returns products AND facets computed over the SAME matched + filtered + visible
 * set (same matcher, same predicates). Contract:
 *  - fallback: "native"  -> app cannot serve (no active index / timeout / DB
 *    error). HTTP 200 with the flag; never a bare 500.
 *  - zeroResult: true    -> index healthy but nothing matched; suggestions given
 *    for a text query.
 *  - FilterValidationError propagates (the route maps it to 400).
 */

const STATEMENT_TIMEOUT_MS = Number(process.env.SEARCH_STATEMENT_TIMEOUT_MS || 3000);

export interface StorefrontSearchResponse {
  query: string;
  products: SearchProduct[];
  total: number;
  strategy: SearchStrategy;
  indexVersion: number | null;
  tookMs: number;
  fallback: "native" | null;
  zeroResult: boolean;
  suggestions: Suggestion[];
  facets: Facet[];
  appliedFilters: SearchFilters;
  priceRange: { min: string; max: string } | null;
}

export async function storefrontSearchWithExec(
  exec: Exec,
  shopId: string,
  params: SearchParams,
): Promise<StorefrontSearchResponse> {
  const started = Date.now();
  const { q, limit, offset } = normalizeParams(params);
  const filters = normalizeFilters(params.filters); // throws FilterValidationError

  const timeout = Math.max(100, Math.min(STATEMENT_TIMEOUT_MS, 10000));
  await exec.run(`SET LOCAL statement_timeout = ${timeout}`);

  const base = {
    query: q,
    products: [] as SearchProduct[],
    total: 0,
    indexVersion: null as number | null,
    tookMs: 0,
    fallback: null as "native" | null,
    zeroResult: false,
    suggestions: [] as Suggestion[],
    facets: [] as Facet[],
    appliedFilters: filters,
    priceRange: null as { min: string; max: string } | null,
  };

  const active = await getActiveVersion(exec, shopId);
  if (!active) {
    return { ...base, strategy: "none", fallback: "native", tookMs: Date.now() - started };
  }

  const tokens = queryTokens(q);
  // q empty -> browse mode (all visible, optionally filtered); q present ->
  // resolve the winning strategy, or null when nothing matches.
  const matcher = await resolveMatcher(exec, shopId, active.id, q, tokens, filters);

  // q present but nothing matched at any stage -> structured zero-result.
  if (!matcher) {
    const suggestions = q.length > 0 ? await catalogSuggestionsWithExec(exec, shopId, q) : [];
    return {
      ...base,
      strategy: "none",
      indexVersion: active.version,
      zeroResult: true,
      suggestions,
      tookMs: Date.now() - started,
    };
  }

  // Sequential (one client cannot run concurrent queries).
  const { rows } = await runProducts(exec, shopId, active.id, matcher, q, filters, limit, offset);
  const facetsResult = await computeFacetsWithExec(exec, shopId, active.id, q, filters, matcher);

  const total = rows[0]?.total ?? 0;
  const ftsTotal = rows[0]?.fts_total ?? 0;
  const skuTotal = rows[0]?.sku_total ?? 0;
  let strategy: SearchStrategy = matcher.kind === "browse" ? "browse" : matcher.stage;
  if (matcher.kind === "stage" && ftsTotal === 0 && skuTotal > 0) strategy = "exact_sku";

  const zeroResult = total === 0;
  const suggestions = zeroResult && q.length > 0 ? await catalogSuggestionsWithExec(exec, shopId, q) : [];

  return {
    query: q,
    products: rows.map(mapRow),
    total,
    strategy,
    indexVersion: active.version,
    tookMs: Date.now() - started,
    fallback: null,
    zeroResult,
    suggestions,
    facets: facetsResult.facets,
    appliedFilters: filters,
    priceRange: facetsResult.priceRange,
  };
}

// Local product mapper (mirrors query.ts's mapDocToProduct without exporting it).
function mapRow(row: { product_id: string; gid: string; doc: any }): SearchProduct {
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

export async function storefrontSearch(
  shopId: string,
  params: SearchParams,
): Promise<StorefrontSearchResponse> {
  const started = Date.now();
  const filtersForEcho = safeFilters(params);
  try {
    return await withShopExec(shopId, (exec) => storefrontSearchWithExec(exec, shopId, params));
  } catch (err) {
    if (err instanceof FilterValidationError) throw err; // route -> 400
    // Timeout / DB error -> native fallback, never a bare 500.
    return {
      query: String(params.q ?? "").slice(0, 200).trim(),
      products: [], total: 0, strategy: "none", indexVersion: null,
      tookMs: Date.now() - started, fallback: "native", zeroResult: false,
      suggestions: [], facets: [], appliedFilters: filtersForEcho, priceRange: null,
    };
  }
}

/** Best-effort filters echo for the fallback path (never throws). */
function safeFilters(params: SearchParams): SearchFilters {
  try {
    return normalizeFilters(params.filters);
  } catch {
    return {
      vendor: [], productType: [], tags: [], priceMin: null, priceMax: null,
      available: null, collectionId: null, metafield: [],
    };
  }
}
