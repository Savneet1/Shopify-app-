import type { Exec } from "~/lib/db/executor";
import { withShopExec } from "~/lib/tenant.server";
import { TS_CONFIG } from "./config";
import { getActiveVersion } from "~/lib/index/engine";

/**
 * Storefront full-text search over the ACTIVE index version (Phase 3).
 *
 * Guarantees / boundaries:
 *  - Reads ONLY the shop's ACTIVE index version, and ONLY documents that are
 *    published to the Online Store (online_store_url IS NOT NULL -> published)
 *    AND status = 'ACTIVE'. Draft / archived / unpublished products can never be
 *    returned.
 *  - All tsqueries are built with parameterised, sanitised input
 *    (websearch_to_tsquery / to_tsquery over immutable_unaccent'd text). User
 *    text is never concatenated into SQL; prefix/OR lexeme strings are assembled
 *    from [\p{L}\p{N}] tokens only, so the tsquery operators (& | :*) are the
 *    only special characters that reach to_tsquery.
 *  - Query length is capped, limit is clamped to <= 50, offset is bounded, and a
 *    per-statement statement_timeout is set (SET LOCAL) so a pathological query
 *    cannot run unbounded.
 *  - ts_rank_cd is the baseline relevance. Exact SKU/barcode matches always rank
 *    first (whole-token match on the concatenated sku_text).
 *  - pg_trgm is used ONLY as the last-resort zero-result fallback (word-similar
 *    title), NOT as typo tolerance — that (Damerau-Levenshtein, synonyms, stop
 *    words, redirects, ranking tuning) is Phase 5 and is deliberately absent.
 */

export const MAX_QUERY_LEN = 200;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 24;
export const MAX_OFFSET = 1000;
const STATEMENT_TIMEOUT_MS = Number(process.env.SEARCH_STATEMENT_TIMEOUT_MS || 3000);

export type SearchStrategy =
  | "exact_sku"
  | "and"
  | "prefix"
  | "or"
  | "trigram"
  | "none";

export interface SearchParams {
  q: string;
  limit?: number;
  offset?: number;
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

/** Clamp/normalise raw request params to safe bounds. */
export function normalizeParams(p: SearchParams): {
  q: string;
  limit: number;
  offset: number;
} {
  const q = String(p.q ?? "").slice(0, MAX_QUERY_LEN).trim();
  let limit = Number.isFinite(p.limit) ? Math.floor(Number(p.limit)) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);
  let offset = Number.isFinite(p.offset) ? Math.floor(Number(p.offset)) : 0;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  offset = Math.min(offset, MAX_OFFSET);
  return { q, limit, offset };
}

/** Extract [\p{L}\p{N}] tokens (lower-cased). Everything else is dropped so the
 * only special characters that can reach to_tsquery are the ones we add. */
export function queryTokens(q: string): string[] {
  const m = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return m ? m.filter((t) => t.length > 0).slice(0, 16) : [];
}

/** AND-lexeme string with the last token as a prefix: "foo & bar:*". */
function prefixLexemes(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const parts = tokens.map((t, i) => (i === tokens.length - 1 ? `${t}:*` : t));
  return parts.join(" & ");
}

/** OR-lexeme string: "foo | bar". */
function orLexemes(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.join(" | ");
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

// Common visibility filter: active version + published to Online Store + ACTIVE
// status. This is the hard guarantee that unpublished/draft/archived products
// are never returned.
const VISIBLE = `shop_id = $1::uuid AND index_version_id = $2::uuid
  AND published = true AND status = 'ACTIVE'`;

// Whole-token exact SKU/barcode probe (case-insensitive) over sku_text.
const SKU_HIT = `(' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($3) || ' %')`;

interface StrategyRow {
  product_id: string;
  gid: string;
  doc: any;
  total: number;
  fts_total: number;
  sku_total: number;
}

/**
 * Run ONE strategy. `matchExpr` is the FTS/trigram predicate (uses $3 = raw q,
 * $4 = lexeme string where applicable). Params are fixed:
 *   $1 shopId, $2 versionId, $3 q, $4 lexemes|null, $5 limit, $6 offset.
 */
async function runStrategy(
  exec: Exec,
  shopId: string,
  versionId: string,
  q: string,
  lexemes: string | null,
  limit: number,
  offset: number,
  matchExpr: string,
  rankExpr: string,
): Promise<{ rows: StrategyRow[] }> {
  // $4 (lexemes) is not referenced by the AND/trigram stages; pin its type with
  // an always-true guard and never pass NULL, so Postgres can infer it in every
  // stage. Empty string is used when a stage has no lexeme input.
  const sql = `
    WITH base AS (
      SELECT product_id, shopify_product_gid AS gid, doc, title,
             (${matchExpr}) AS fts_hit,
             (${SKU_HIT})  AS sku_hit,
             (${rankExpr}) AS rank
      FROM product_search_doc
      WHERE ${VISIBLE} AND $4::text = $4::text AND ((${matchExpr}) OR (${SKU_HIT}))
    )
    SELECT b.product_id, b.gid, b.doc,
           (SELECT count(*)::int FROM base) AS total,
           (SELECT count(*)::int FROM base WHERE fts_hit) AS fts_total,
           (SELECT count(*)::int FROM base WHERE sku_hit) AS sku_total
    FROM base b
    ORDER BY b.sku_hit DESC, b.rank DESC NULLS LAST, b.title ASC
    LIMIT $5::int OFFSET $6::int`;
  const rows = await exec.rows<StrategyRow>(sql, [shopId, versionId, q, lexemes ?? "", limit, offset]);
  return { rows };
}

const WEBSEARCH = `websearch_to_tsquery('${TS_CONFIG}', immutable_unaccent($3))`;
const TOQUERY_LEX = `to_tsquery('${TS_CONFIG}', immutable_unaccent($4))`;

/**
 * Execute the strategy cascade against the ACTIVE version, inside an existing
 * tenant Exec (transaction). Sets a per-statement timeout. Returns a full
 * SearchResponse. Throws only on an unexpected DB error (caller maps to fallback).
 */
export async function searchWithExec(
  exec: Exec,
  shopId: string,
  params: SearchParams,
): Promise<SearchResponse> {
  const started = Date.now();
  const { q, limit, offset } = normalizeParams(params);

  // Bound every statement in this tx. Integer is validated, not user input.
  const timeout = Math.max(100, Math.min(STATEMENT_TIMEOUT_MS, 10000));
  await exec.run(`SET LOCAL statement_timeout = ${timeout}`);

  const active = await getActiveVersion(exec, shopId);
  if (!active) {
    // No index yet -> caller should fall back to native search.
    return {
      products: [],
      total: 0,
      strategy: "none",
      indexVersion: null,
      tookMs: Date.now() - started,
      fallback: "native",
    };
  }

  const empty = (strategy: SearchStrategy): SearchResponse => ({
    products: [],
    total: 0,
    strategy,
    indexVersion: active.version,
    tookMs: Date.now() - started,
  });

  if (q.length === 0) return empty("none");

  const tokens = queryTokens(q);
  const prefix = prefixLexemes(tokens);
  const or = orLexemes(tokens);

  // Cascade: AND (websearch) -> prefix -> OR -> trigram. Exact SKU/barcode is
  // OR-ed into every stage and always sorts first, so an exact code match is
  // never lost and always leads.
  const RANK_FTS = (matchQ: string) => `ts_rank_cd(tsv, ${matchQ})`;
  const stages: Array<{ label: SearchStrategy; match: string; rank: string; lex: string | null }> = [
    { label: "and", match: `tsv @@ ${WEBSEARCH}`, rank: RANK_FTS(WEBSEARCH), lex: null },
  ];
  if (prefix) {
    stages.push({ label: "prefix", match: `tsv @@ ${TOQUERY_LEX}`, rank: RANK_FTS(TOQUERY_LEX), lex: prefix });
  }
  if (or) {
    stages.push({ label: "or", match: `tsv @@ ${TOQUERY_LEX}`, rank: RANK_FTS(TOQUERY_LEX), lex: or });
  }
  // Trigram last-resort (word similarity of the title). NOT typo tolerance.
  stages.push({
    label: "trigram",
    match: `immutable_unaccent(lower(coalesce(title,''))) %> immutable_unaccent(lower($3))`,
    rank: `word_similarity(immutable_unaccent(lower($3)), immutable_unaccent(lower(coalesce(title,''))))`,
    lex: null,
  });

  for (const stage of stages) {
    const { rows } = await runStrategy(
      exec, shopId, active.id, q, stage.lex, limit, offset, stage.match, stage.rank,
    );
    const total = rows[0]?.total ?? 0;
    if (total > 0) {
      const ftsTotal = rows[0]?.fts_total ?? 0;
      const skuTotal = rows[0]?.sku_total ?? 0;
      // Honest strategy label: if only the exact-SKU probe matched (FTS stage
      // found nothing), report exact_sku.
      const strategy: SearchStrategy = ftsTotal === 0 && skuTotal > 0 ? "exact_sku" : stage.label;
      return {
        products: rows.map(mapDocToProduct),
        total,
        strategy,
        indexVersion: active.version,
        tookMs: Date.now() - started,
      };
    }
  }

  // Nothing matched at any stage — a genuine zero-result (handled structurally
  // by the fallback layer; NOT a native fallback, the index is healthy).
  return empty("none");
}

/**
 * Public entry: resolve tenant context, run the cascade, and translate any
 * unexpected error (timeout / DB error) into a native fallback response so the
 * storefront never receives a bare 500.
 */
export async function searchProducts(
  shopId: string,
  params: SearchParams,
): Promise<SearchResponse> {
  const started = Date.now();
  try {
    return await withShopExec(shopId, (exec) => searchWithExec(exec, shopId, params));
  } catch {
    return {
      products: [],
      total: 0,
      strategy: "none",
      indexVersion: null,
      tookMs: Date.now() - started,
      fallback: "native",
    };
  }
}
