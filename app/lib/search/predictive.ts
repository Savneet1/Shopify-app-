import type { Exec } from "~/lib/db/executor";
import { withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";
import {
  searchWithExec,
  normalizeParams,
  type SearchProduct,
  type SearchStrategy,
} from "./query";
import { catalogSuggestionsWithExec, type Suggestion } from "./suggest";

/**
 * Predictive (as-you-type) search (Phase 3.4): a small, fast set of product
 * matches PLUS catalog-derived suggestions, in one call. It reuses the same
 * strategy cascade and the same ACTIVE-version / published+ACTIVE visibility
 * guarantees as full search — so predictive can never surface a draft or
 * unpublished product either. Suggestions are catalog-derived only (no
 * popularity — Phase 11).
 */

export const PREDICTIVE_DEFAULT_LIMIT = 6;
export const PREDICTIVE_MAX_LIMIT = 10;

export interface PredictiveResponse {
  products: SearchProduct[];
  suggestions: Suggestion[];
  total: number;
  strategy: SearchStrategy;
  indexVersion: number | null;
  tookMs: number;
  fallback?: "native";
}

function clampPredictiveLimit(limit?: number): number {
  let l = Number.isFinite(limit) ? Math.floor(Number(limit)) : PREDICTIVE_DEFAULT_LIMIT;
  if (!Number.isFinite(l) || l <= 0) l = PREDICTIVE_DEFAULT_LIMIT;
  return Math.min(l, PREDICTIVE_MAX_LIMIT);
}

/** Core predictive search over an existing tenant Exec (transaction). */
export async function predictiveWithExec(
  exec: Exec,
  shopId: string,
  params: { q: string; limit?: number },
): Promise<PredictiveResponse> {
  const started = Date.now();
  const { q } = normalizeParams({ q: params.q });
  const limit = clampPredictiveLimit(params.limit);

  await exec.run(`SET LOCAL statement_timeout = 2000`);
  const active = await getActiveVersion(exec, shopId);
  if (!active) {
    return {
      products: [], suggestions: [], total: 0, strategy: "none",
      indexVersion: null, tookMs: Date.now() - started, fallback: "native",
    };
  }
  // As-you-type: an empty query yields nothing (predictive never browse-dumps
  // the whole catalog — that is the products/browse endpoint's job).
  if (q.length === 0) {
    return {
      products: [], suggestions: [], total: 0, strategy: "none",
      indexVersion: active.version, tookMs: Date.now() - started,
    };
  }
  // Products via the shared cascade (small page). searchWithExec sets its own
  // statement_timeout; both are SET LOCAL, harmless to re-set.
  const res = await searchWithExec(exec, shopId, { q, limit, offset: 0 });
  const suggestions = await catalogSuggestionsWithExec(exec, shopId, q, PREDICTIVE_MAX_LIMIT);
  return {
    products: res.products,
    suggestions,
    total: res.total,
    strategy: res.strategy,
    indexVersion: active.version,
    tookMs: Date.now() - started,
  };
}

export async function predictiveSearch(
  shopId: string,
  params: { q: string; limit?: number },
): Promise<PredictiveResponse> {
  const started = Date.now();
  try {
    return await withShopExec(shopId, (exec) => predictiveWithExec(exec, shopId, params));
  } catch {
    return {
      products: [], suggestions: [], total: 0, strategy: "none",
      indexVersion: null, tookMs: Date.now() - started, fallback: "native",
    };
  }
}
