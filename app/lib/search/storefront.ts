import type { Exec } from "~/lib/db/executor";
import { withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";
import {
  normalizeParams,
  resolvePlanned,
  runProducts,
  strategyOf,
  type SearchProduct,
  type SearchStrategy,
  type SearchParams,
  type Correction,
} from "./query";
import { normalizeFilters, FilterValidationError, type SearchFilters } from "./filters";
import { buildPlan } from "./rewrite";
import { computeFacetsWithExec, type Facet } from "./facets";
import { catalogSuggestionsWithExec, type Suggestion } from "./suggest";
import { matchRedirect } from "./redirects";

/**
 * Storefront orchestrator (Phase 3 fallback + Phase 4 facets + Phase 5 relevance).
 * Order of operations: redirect check → plan (stop words / typo / synonym) →
 * ranked products + facets over the SAME planned match. Contract:
 *  - redirect: <path> when a redirect rule matches the normalized query (payload
 *    only; the server never issues a 30x).
 *  - fallback: "native" on no active index / timeout / DB error (HTTP 200).
 *  - zeroResult + suggestions when nothing matched.
 *  - corrected + corrections (+ correctedQuery) when a typo correction applied.
 * FilterValidationError propagates (route → 400).
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
  corrected: boolean;
  corrections: Correction[];
  correctedQuery: string | null;
  redirect: string | null;
}

function correctedQueryString(keptTokens: string[], corrections: Correction[]): string | null {
  if (corrections.length === 0) return null;
  const map = new Map(corrections.map((c) => [c.from, c.to]));
  return keptTokens.map((t) => map.get(t) ?? t).join(" ");
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
    query: q, products: [] as SearchProduct[], total: 0, indexVersion: null as number | null,
    tookMs: 0, fallback: null as "native" | null, zeroResult: false, suggestions: [] as Suggestion[],
    facets: [] as Facet[], appliedFilters: filters, priceRange: null as { min: string; max: string } | null,
    corrected: false, corrections: [] as Correction[], correctedQuery: null as string | null, redirect: null as string | null,
  };

  const active = await getActiveVersion(exec, shopId);
  if (!active) return { ...base, strategy: "none", fallback: "native", tookMs: Date.now() - started };

  // 1) Redirect (exact match on the normalized query). Payload only.
  if (q.length > 0) {
    const redirect = await matchRedirect(exec, shopId, q);
    if (redirect) {
      return { ...base, strategy: "none", indexVersion: active.version, redirect, tookMs: Date.now() - started };
    }
  }

  // 2) Plan (stop words → typo correction → synonym expansion).
  const plan = await buildPlan(exec, shopId, active.id, q);
  const planned = await resolvePlanned(exec, shopId, active.id, plan, filters);
  const corrections = plan.corrections;
  const correctedQuery = correctedQueryString(plan.keptTokens, corrections);

  if (!planned) {
    const suggestions = q.length > 0 ? await catalogSuggestionsWithExec(exec, shopId, q) : [];
    return {
      ...base, strategy: "none", indexVersion: active.version, zeroResult: true,
      suggestions, corrections, correctedQuery, tookMs: Date.now() - started,
    };
  }

  // 3) Ranked products + facets over the SAME planned match (sequential).
  const { rows } = await runProducts(exec, shopId, active.id, planned, filters, limit, offset);
  const facetsResult = await computeFacetsWithExec(exec, shopId, active.id, filters, planned);

  const total = rows[0]?.total ?? 0;
  const strategy = strategyOf(planned, rows[0]?.cls, total);
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
    corrected: corrections.length > 0 && total > 0,
    corrections,
    correctedQuery,
    redirect: null,
  };
}

function mapRow(row: { product_id: string; gid: string; doc: any; cls?: any; score?: any }): SearchProduct {
  const d = row.doc ?? {};
  const img = d.image ?? {};
  return {
    id: row.product_id, gid: row.gid, title: d.title ?? null, handle: d.handle ?? null, url: d.url ?? null,
    vendor: d.vendor ?? null, productType: d.productType ?? null,
    image: { url: img.url ?? null, alt: img.alt ?? null },
    priceMin: d.priceMin != null ? String(d.priceMin) : null,
    priceMax: d.priceMax != null ? String(d.priceMax) : null,
    compareAtMin: d.compareAtMin != null ? String(d.compareAtMin) : null,
    compareAtMax: d.compareAtMax != null ? String(d.compareAtMax) : null,
    available: Boolean(d.available), matchClass: row.cls, score: row.score != null ? Number(row.score) : undefined,
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
    if (err instanceof FilterValidationError) throw err;
    return {
      query: String(params.q ?? "").slice(0, 200).trim(),
      products: [], total: 0, strategy: "none", indexVersion: null, tookMs: Date.now() - started,
      fallback: "native", zeroResult: false, suggestions: [], facets: [], appliedFilters: filtersForEcho,
      priceRange: null, corrected: false, corrections: [], correctedQuery: null, redirect: null,
    };
  }
}

function safeFilters(params: SearchParams): SearchFilters {
  try {
    return normalizeFilters(params.filters);
  } catch {
    return { vendor: [], productType: [], tags: [], priceMin: null, priceMax: null, available: null, collectionId: null, metafield: [] };
  }
}
