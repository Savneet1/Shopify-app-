import type { Exec } from "~/lib/db/executor";
import { withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";
import { normalizeParams } from "./query";

/**
 * Catalog-derived suggestions (Phase 3.4).
 *
 * Suggestions are terms drawn from the CATALOG itself — product titles, vendors,
 * product types and collection titles of the shop's visible (published, active)
 * products — that begin with the typed prefix. They are NOT popularity/trending
 * based (that needs query analytics, which is Phase 11 and deliberately not
 * built here). Ranking is a simple, deterministic field-weight + shortest-first,
 * so it is reproducible without any behavioural data.
 */

export interface Suggestion {
  text: string;
  type: "title" | "vendor" | "productType" | "collection";
}

const SUGGEST_MAX = 10;

// Field weights: a title prefix is the most useful completion, then product
// type / vendor, then collection. Lower weight sorts first.
const FIELD_WEIGHT: Record<Suggestion["type"], number> = {
  title: 0,
  productType: 1,
  vendor: 2,
  collection: 3,
};

interface RawSuggestion {
  text: string;
  type: Suggestion["type"];
}

/** Collect catalog terms beginning with `prefix` from the ACTIVE version docs. */
export async function catalogSuggestionsWithExec(
  exec: Exec,
  shopId: string,
  prefix: string,
  limit = SUGGEST_MAX,
): Promise<Suggestion[]> {
  const active = await getActiveVersion(exec, shopId);
  if (!active) return [];
  const q = prefix.trim();
  if (q.length === 0) return [];

  // Accent-folded, case-insensitive prefix match. `%` / `_` in user input are
  // escaped so they cannot act as LIKE wildcards; the trailing `%` we add is the
  // prefix wildcard. ESCAPE '\' makes the escaping explicit.
  const like = `${q.replace(/([%_\\])/g, "\\$1")}%`;

  // Titles + vendor + productType come straight off the doc; collection titles
  // are unnested from the doc's collections array. All restricted to visible
  // (published + ACTIVE) docs in the active version.
  const rows = await exec.rows<RawSuggestion>(
    `
    WITH visible AS (
      SELECT doc, title FROM product_search_doc
      WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
        AND published = true AND status = 'ACTIVE'
    ),
    terms AS (
      SELECT title AS text, 'title'::text AS type FROM visible WHERE title IS NOT NULL
      UNION ALL
      SELECT doc->>'vendor', 'vendor' FROM visible WHERE doc->>'vendor' IS NOT NULL
      UNION ALL
      SELECT doc->>'productType', 'productType' FROM visible WHERE doc->>'productType' IS NOT NULL
      UNION ALL
      SELECT jsonb_array_elements_text(doc->'collections'), 'collection'
        FROM visible WHERE jsonb_typeof(doc->'collections') = 'array'
    )
    SELECT text, type
    FROM terms
    WHERE text <> '' AND immutable_unaccent(lower(text)) LIKE immutable_unaccent(lower($3)) ESCAPE '\\'
    GROUP BY text, type
    `,
    [shopId, active.id, like],
  );

  // Deduplicate by lowercased text (keep the best-weighted field), then sort by
  // field weight, then shortest, then alphabetical — fully deterministic.
  const best = new Map<string, RawSuggestion>();
  for (const r of rows) {
    const key = r.text.toLowerCase();
    const existing = best.get(key);
    if (!existing || FIELD_WEIGHT[r.type] < FIELD_WEIGHT[existing.type]) {
      best.set(key, r);
    }
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        FIELD_WEIGHT[a.type] - FIELD_WEIGHT[b.type] ||
        a.text.length - b.text.length ||
        a.text.localeCompare(b.text),
    )
    .slice(0, Math.min(limit, SUGGEST_MAX))
    .map((r) => ({ text: r.text, type: r.type }));
}

export interface SuggestResponse {
  suggestions: Suggestion[];
  indexVersion: number | null;
  tookMs: number;
  fallback?: "native";
}

/** Public entry: catalog suggestions for a prefix. Never throws to the caller. */
export async function suggest(
  shopId: string,
  params: { q: string; limit?: number },
): Promise<SuggestResponse> {
  const started = Date.now();
  const { q, limit } = normalizeParams({ q: params.q, limit: params.limit });
  try {
    return await withShopExec(shopId, async (exec) => {
      await exec.run(`SET LOCAL statement_timeout = 2000`);
      const active = await getActiveVersion(exec, shopId);
      if (!active) {
        return { suggestions: [], indexVersion: null, tookMs: Date.now() - started, fallback: "native" as const };
      }
      const suggestions = await catalogSuggestionsWithExec(exec, shopId, q, limit);
      return { suggestions, indexVersion: active.version, tookMs: Date.now() - started };
    });
  } catch {
    return { suggestions: [], indexVersion: null, tookMs: Date.now() - started, fallback: "native" };
  }
}
