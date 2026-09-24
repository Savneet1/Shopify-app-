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
 * Storefront-facing search orchestrator (Phase 3.5).
 *
 * Wraps the strategy cascade with the degraded-mode / zero-result contract the
 * storefront API depends on:
 *
 *  - fallback: "native"  -> the app cannot serve results (no active index yet,
 *    statement timeout, or a DB error). The storefront should fall back to the
 *    theme's native search. The route still returns HTTP 200 with this flag —
 *    NEVER a bare 500 — so the theme can degrade gracefully.
 *  - zeroResult: true    -> the index is healthy but nothing matched. A
 *    structured block is returned with catalog-derived suggestions so the
 *    storefront can offer recovery options instead of a dead end.
 *
 * Everything runs in ONE tenant transaction so search + suggestions share the
 * same snapshot and statement timeout.
 */

export interface StorefrontSearchResponse {
  query: string;
  products: SearchProduct[];
  total: number;
  strategy: SearchStrategy;
  indexVersion: number | null;
  tookMs: number;
  /** "native" when the theme should use its own search; null otherwise. */
  fallback: "native" | null;
  /** true when the index is healthy but produced no matches. */
  zeroResult: boolean;
  /** catalog-derived recovery suggestions (present on zero-result). */
  suggestions: Suggestion[];
}

/** Core storefront search over an existing tenant Exec (transaction). Contains
 * the no-active-index and zero-result logic; the public wrapper adds the tenant
 * transaction and the timeout/DB-error -> native fallback guard. */
export async function storefrontSearchWithExec(
  exec: Exec,
  shopId: string,
  params: { q: string; limit?: number; offset?: number },
): Promise<StorefrontSearchResponse> {
  const started = Date.now();
  const { q, limit, offset } = normalizeParams(params);

  const active = await getActiveVersion(exec, shopId);
  if (!active) {
    return {
      query: q, products: [], total: 0, strategy: "none",
      indexVersion: null, tookMs: Date.now() - started,
      fallback: "native", zeroResult: false, suggestions: [],
    };
  }

  const res = await searchWithExec(exec, shopId, { q, limit, offset });

  // A healthy index with no matches is a zero-result (not a native fallback).
  const zeroResult = res.total === 0 && q.length > 0;
  const suggestions = zeroResult
    ? await catalogSuggestionsWithExec(exec, shopId, q)
    : [];

  return {
    query: q,
    products: res.products,
    total: res.total,
    strategy: res.strategy,
    indexVersion: res.indexVersion,
    tookMs: Date.now() - started,
    fallback: null,
    zeroResult,
    suggestions,
  };
}

export async function storefrontSearch(
  shopId: string,
  params: { q: string; limit?: number; offset?: number },
): Promise<StorefrontSearchResponse> {
  const started = Date.now();
  const { q } = normalizeParams(params);
  try {
    return await withShopExec(shopId, (exec) => storefrontSearchWithExec(exec, shopId, params));
  } catch {
    // Timeout / DB error -> advise native fallback, never a bare 500.
    return {
      query: q, products: [], total: 0, strategy: "none",
      indexVersion: null, tookMs: Date.now() - started,
      fallback: "native", zeroResult: false, suggestions: [],
    };
  }
}
