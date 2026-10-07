import type { Exec } from "~/lib/db/executor";
import { withShopExec } from "~/lib/tenant.server";
import { getActiveVersion, type IndexVersionRow } from "~/lib/index/engine";
import {
  normalizeParams,
  normalizeSort,
  resolvePlanned,
  runProducts,
  strategyOf,
  type SearchProduct,
  type SearchStrategy,
  type SearchParams,
  type SortOption,
  type Correction,
} from "./query";
import { normalizeFilters, FilterValidationError, type SearchFilters, type RawFilters } from "./filters";
import { buildPlan } from "./rewrite";
import { computeFacetsWithExec, type Facet } from "./facets";
import { catalogSuggestionsWithExec, type Suggestion } from "./suggest";
import { matchRedirect } from "./redirects";
import { buildParseContext, parseQuery, type InterpretedItem, type InterpretKind } from "./nlparse";

/**
 * Storefront orchestrator (Phase 3 fallback + Phase 4 facets + Phase 5 relevance
 * + Phase 6 NL parsing). Phase 6 runs the rule-based parser FIRST, merges the
 * extracted intent into the EXISTING filters + sort, and feeds the remaining
 * free text to the SAME Phase 5 planner — so products and facet counts use one
 * code path. Guarantees:
 *  - never worse than Phase 5: if parsing yields zero results while plain search
 *    would not, it falls back to plain search (fellBack=true).
 *  - transparency: `interpretedAs` shows what was extracted and the remaining text.
 *  - parsed values pass through the SAME normalizeFilters() validation.
 */

const STATEMENT_TIMEOUT_MS = Number(process.env.SEARCH_STATEMENT_TIMEOUT_MS || 3000);

export interface StorefrontParams extends SearchParams {
  /** NL parsing on by default; false disables it (plain Phase 5 search). */
  nl?: boolean;
  /** Interpretation kinds to skip (drop individual interpretations). */
  ignore?: InterpretKind[];
}

export interface InterpretedAs {
  enabled: boolean;
  applied: boolean;
  interpreted: InterpretedItem[];
  remaining: string;
  negations: string[];
  /** A3: phrases the shopper negated that were NOT applied (negative filtering
   * is unsupported). Mirrors `negations`; named for UI consumption. */
  negationIgnored: string[];
  /** A3: human-readable note when something was negated but ignored, else null. */
  warning: string | null;
  sort: SortOption | null;
  fellBack: boolean;
}

/** Build the human-readable negation warning (A3), or null when nothing was
 * negated. Deterministic and UI-ready. */
function negationWarning(negations: string[]): string | null {
  if (negations.length === 0) return null;
  const list = negations.map((n) => `"${n}"`).join(", ");
  return `Negative filtering isn't supported yet, so ${list} ${negations.length === 1 ? "was" : "were"} ignored.`;
}

export interface StorefrontSearchResponse {
  query: string;
  products: SearchProduct[];
  total: number;
  strategy: SearchStrategy;
  sort: SortOption;
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
  interpretedAs: InterpretedAs;
}

interface CoreResult {
  products: SearchProduct[];
  total: number;
  strategy: SearchStrategy;
  facets: Facet[];
  priceRange: { min: string; max: string } | null;
  corrected: boolean;
  corrections: Correction[];
  correctedQuery: string | null;
}

function mapRow(row: { product_id: string; gid: string; doc: any; cls?: any; score?: any }): SearchProduct {
  const d = row.doc ?? {};
  const img = d.image ?? {};
  return {
    id: row.product_id, gid: row.gid, title: d.title ?? null, handle: d.handle ?? null, url: d.url ?? null,
    vendor: d.vendor ?? null, productType: d.productType ?? null, image: { url: img.url ?? null, alt: img.alt ?? null },
    priceMin: d.priceMin != null ? String(d.priceMin) : null, priceMax: d.priceMax != null ? String(d.priceMax) : null,
    compareAtMin: d.compareAtMin != null ? String(d.compareAtMin) : null, compareAtMax: d.compareAtMax != null ? String(d.compareAtMax) : null,
    available: Boolean(d.available), matchClass: row.cls, score: row.score != null ? Number(row.score) : undefined,
  };
}

function correctedQueryString(keptTokens: string[], corrections: Correction[]): string | null {
  if (corrections.length === 0) return null;
  const map = new Map(corrections.map((c) => [c.from, c.to]));
  return keptTokens.map((t) => map.get(t) ?? t).join(" ");
}

/** Run plan → ranked products → facets for a given q/filters/sort. One code path. */
async function runCore(
  exec: Exec, shopId: string, active: IndexVersionRow, q: string, filters: SearchFilters,
  sort: SortOption, limit: number, offset: number,
): Promise<CoreResult> {
  const plan = await buildPlan(exec, shopId, active.id, q);
  const planned = await resolvePlanned(exec, shopId, active.id, plan, filters);
  const corrections = plan.corrections;
  const correctedQuery = correctedQueryString(plan.keptTokens, corrections);
  if (!planned) {
    return { products: [], total: 0, strategy: "none", facets: [], priceRange: null, corrected: false, corrections, correctedQuery };
  }
  const { rows } = await runProducts(exec, shopId, active.id, planned, filters, limit, offset, sort);
  const facetsResult = await computeFacetsWithExec(exec, shopId, active.id, filters, planned);
  const total = rows[0]?.total ?? 0;
  return {
    products: rows.map(mapRow), total, strategy: strategyOf(planned, rows[0]?.cls, total),
    facets: facetsResult.facets, priceRange: facetsResult.priceRange,
    corrected: corrections.length > 0 && total > 0, corrections, correctedQuery,
  };
}

/** Union array filter fields; explicit scalars take precedence over parsed. */
function mergeRawFilters(explicit: RawFilters, parsed: RawFilters): RawFilters {
  const arr = (a: string[] | string | undefined): string[] => (a == null ? [] : Array.isArray(a) ? a : [a]);
  const uniq = (xs: string[]) => [...new Set(xs.map((s) => s.trim()).filter(Boolean))];
  return {
    vendor: uniq([...arr(explicit.vendor), ...arr(parsed.vendor)]),
    productType: uniq([...arr(explicit.productType), ...arr(parsed.productType)]),
    tags: uniq([...arr(explicit.tags), ...arr(parsed.tags)]),
    metafield: uniq([...arr(explicit.metafield), ...arr(parsed.metafield)]),
    priceMin: explicit.priceMin ?? parsed.priceMin ?? null,
    priceMax: explicit.priceMax ?? parsed.priceMax ?? null,
    available: explicit.available ?? parsed.available ?? null,
    collectionId: explicit.collectionId ?? null, // NL does not parse collection scope
  };
}

export async function storefrontSearchWithExec(
  exec: Exec,
  shopId: string,
  params: StorefrontParams,
): Promise<StorefrontSearchResponse> {
  const started = Date.now();
  const { q, limit, offset } = normalizeParams(params);
  const explicitRaw = params.filters ?? {};
  const explicitFilters = normalizeFilters(explicitRaw); // throws FilterValidationError
  const explicitSort = params.sort != null ? normalizeSort(params.sort) : undefined;
  const nlEnabled = params.nl !== false;

  const timeout = Math.max(100, Math.min(STATEMENT_TIMEOUT_MS, 10000));
  await exec.run(`SET LOCAL statement_timeout = ${timeout}`);

  const baseInterpreted: InterpretedAs = { enabled: nlEnabled, applied: false, interpreted: [], remaining: q, negations: [], negationIgnored: [], warning: null, sort: null, fellBack: false };
  const base = {
    query: q, products: [] as SearchProduct[], total: 0, sort: explicitSort ?? ("relevance" as SortOption),
    indexVersion: null as number | null, tookMs: 0, fallback: null as "native" | null, zeroResult: false,
    suggestions: [] as Suggestion[], facets: [] as Facet[], appliedFilters: explicitFilters,
    priceRange: null as { min: string; max: string } | null, corrected: false, corrections: [] as Correction[],
    correctedQuery: null as string | null, redirect: null as string | null, interpretedAs: baseInterpreted,
  };

  const active = await getActiveVersion(exec, shopId);
  if (!active) return { ...base, strategy: "none", fallback: "native", tookMs: Date.now() - started };

  // Redirect (exact normalized-query match) short-circuits, as in Phase 5.
  if (q.length > 0) {
    const redirect = await matchRedirect(exec, shopId, q);
    if (redirect) return { ...base, strategy: "none", indexVersion: active.version, redirect, tookMs: Date.now() - started };
  }

  // Phase 6: parse → merge → effective params.
  let effectiveQ = q;
  let effectiveFilters = explicitFilters;
  let effectiveSort: SortOption = explicitSort ?? "relevance";
  let interpretedAs = { ...baseInterpreted };

  if (nlEnabled && q.length > 0) {
    const ctx = await buildParseContext(exec, shopId, active.id);
    const ignore = new Set<InterpretKind>(params.ignore ?? []);
    const parsed = parseQuery(q, ctx, { ignore });
    if (parsed.interpreted.length > 0 || parsed.negations.length > 0) {
      effectiveFilters = normalizeFilters(mergeRawFilters(explicitRaw, parsed.filters)); // same validation
      effectiveQ = parsed.remaining;
      effectiveSort = explicitSort ?? parsed.sort ?? "relevance";
      interpretedAs = {
        enabled: true, applied: true, interpreted: parsed.interpreted, remaining: parsed.remaining,
        negations: parsed.negations, negationIgnored: parsed.negations,
        warning: negationWarning(parsed.negations), sort: parsed.sort ?? null, fellBack: false,
      };
    }
  }

  // Effective (parsed) search.
  let core = await runCore(exec, shopId, active, effectiveQ, effectiveFilters, effectiveSort, limit, offset);
  let appliedFilters = effectiveFilters;
  let usedSort = effectiveSort;
  let usedQuery = effectiveQ;

  // Never worse than Phase 5: if parsing produced zero results but plain search
  // would not, fall back to plain search.
  if (interpretedAs.applied && core.total === 0) {
    const plain = await runCore(exec, shopId, active, q, explicitFilters, explicitSort ?? "relevance", limit, offset);
    if (plain.total > 0) {
      core = plain;
      appliedFilters = explicitFilters;
      usedSort = explicitSort ?? "relevance";
      usedQuery = q;
      interpretedAs = { ...interpretedAs, fellBack: true };
    }
  }

  const zeroResult = core.total === 0;
  const suggestions = zeroResult && usedQuery.length > 0 ? await catalogSuggestionsWithExec(exec, shopId, usedQuery) : [];

  return {
    query: q,
    products: core.products,
    total: core.total,
    strategy: core.strategy,
    sort: usedSort,
    indexVersion: active.version,
    tookMs: Date.now() - started,
    fallback: null,
    zeroResult,
    suggestions,
    facets: core.facets,
    appliedFilters,
    priceRange: core.priceRange,
    corrected: core.corrected,
    corrections: core.corrections,
    correctedQuery: core.correctedQuery,
    redirect: null,
    interpretedAs,
  };
}

export async function storefrontSearch(
  shopId: string,
  params: StorefrontParams,
): Promise<StorefrontSearchResponse> {
  const started = Date.now();
  const filtersForEcho = safeFilters(params);
  try {
    return await withShopExec(shopId, (exec) => storefrontSearchWithExec(exec, shopId, params));
  } catch (err) {
    if (err instanceof FilterValidationError) throw err;
    return {
      query: String(params.q ?? "").slice(0, 200).trim(), products: [], total: 0, strategy: "none",
      sort: "relevance", indexVersion: null, tookMs: Date.now() - started, fallback: "native", zeroResult: false,
      suggestions: [], facets: [], appliedFilters: filtersForEcho, priceRange: null, corrected: false,
      corrections: [], correctedQuery: null, redirect: null,
      interpretedAs: { enabled: params.nl !== false, applied: false, interpreted: [], remaining: "", negations: [], negationIgnored: [], warning: null, sort: null, fellBack: false },
    };
  }
}

function safeFilters(params: StorefrontParams): SearchFilters {
  try {
    return normalizeFilters(params.filters);
  } catch {
    return { vendor: [], productType: [], tags: [], priceMin: null, priceMax: null, available: null, collectionId: null, metafield: [] };
  }
}
