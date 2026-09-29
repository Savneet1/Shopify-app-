import {
  Params,
  visibilityPredicate,
  collectionPredicate,
  filterPredicates,
  type SearchFilters,
  type FacetGroup,
} from "./filters";
import { type QueryPlan, andLex, prefixLex, orLex, fuzzyLex } from "./rewrite";
import { toTsQuery } from "./ranking";

/**
 * Effective match predicate for a planned query (Phase 5). Built with a Params
 * accumulator (fully parameterised) and shared by BOTH the product query
 * (query.ts) and the facet counts (facets.ts), so facets always reflect exactly
 * the same matched set — including under fuzzy correction, synonym expansion and
 * stop-word removal.
 *
 * Two levels (a narrow→broad cascade, resolved once in query.ts):
 *   - primary: exact/prefix of the kept tokens OR synonym expansions OR fuzzy
 *     corrections OR an exact SKU hit.
 *   - partial: any kept token (OR) OR an exact SKU hit — the recall fallback,
 *     used only when the primary level matched nothing.
 * browse (empty query) applies no text predicate.
 */

export type PlanLevel = "browse" | "primary" | "partial";
export interface PlannedMatch {
  plan: QueryPlan;
  level: PlanLevel;
}

/** Whole-token exact SKU/barcode probe on the raw query. */
export function skuHitPredicate(pb: Params, rawQuery: string): string {
  return `(' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower(${pb.add(rawQuery.trim())}) || ' %')`;
}

/** The text-match clause for a planned level, or null for browse / no tokens. */
export function textPredicate(pb: Params, m: PlannedMatch): string | null {
  const { plan, level } = m;
  if (level === "browse" || plan.keptTokens.length === 0) return null;
  const parts: string[] = [];
  if (level === "primary") {
    parts.push(`tsv @@ ${toTsQuery(pb.add(prefixLex(plan.keptTokens)))}`); // exact + prefix
    for (const e of plan.synonymExpansions) parts.push(`tsv @@ ${toTsQuery(pb.add(andLex(e)))}`);
    const fl = fuzzyLex(plan.positions);
    if (fl) parts.push(`tsv @@ ${toTsQuery(pb.add(fl))}`);
  } else {
    parts.push(`tsv @@ ${toTsQuery(pb.add(orLex(plan.keptTokens)))}`); // any-term recall fallback
  }
  parts.push(skuHitPredicate(pb, plan.raw));
  return `(${parts.join(" OR ")})`;
}

/** Full WHERE: visibility + collection scope + filters + (optional) text match.
 * `exclude` drops one facet group for the own-selection-excluded facet counts. */
export function buildWhere(
  pb: Params,
  shopId: string,
  versionId: string,
  filters: SearchFilters,
  m: PlannedMatch,
  exclude?: FacetGroup,
): string {
  const parts = [visibilityPredicate(pb, shopId, versionId)];
  const col = collectionPredicate(pb, shopId, filters.collectionId);
  if (col) parts.push(col);
  for (const p of filterPredicates(pb, filters, exclude)) parts.push(p);
  const tp = textPredicate(pb, m);
  if (tp) parts.push(tp);
  return parts.join(" AND ");
}
