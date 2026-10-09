import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { classifyRef, partitionRefs, type ProductRef } from "./refs";
import type { ContentCard } from "./content";

/**
 * Phase 9.2 — trending signals + time-decayed trending score.
 *
 * SIGNALS (product_signal_daily) are AGGREGATE per-product, per-UTC-day counters
 * (views, clicks). They are fed by a PUBLIC App Proxy beacon (proxy/rec-event)
 * with the same discipline as the Phase 8 A/B beacon:
 *   - every client value is validated BEFORE any SQL (classifyRef → a real,
 *     visible product of this shop; junk is dropped, never cast);
 *   - only a bounded aggregate counter is incremented — NO visitor id, NO IP,
 *     NO per-user row, NO query text, NO logging of the request;
 *   - recordSignal never throws / never 500s (returns a boolean).
 * Because the beacon is public and inflatable, the counts are ADVISORY: trending
 * is a heuristic shelf, never an authoritative or billable metric. Documented in
 * docs/PHASE9.md.
 *
 * TRENDING SCORE is deterministic: a time-decayed sum over the daily rows with a
 * documented half-life. A row `age` days old contributes
 *   (views·VIEW_WEIGHT + clicks·CLICK_WEIGHT) · 0.5^(age / halfLifeDays)
 * The clock (`now`) is injected so tests are deterministic. When no product has
 * any signal, trending falls back to a documented deterministic order (newest
 * visible products); when signals cover fewer than the requested count, the
 * shelf is topped up with newest visible products (never already included).
 */

/** Clicks are a stronger intent signal than views. Documented, not learned. */
export const VIEW_WEIGHT = 1;
export const CLICK_WEIGHT = 3;
export const DEFAULT_HALF_LIFE_DAYS = 7;

export type SignalType = "view" | "click";

function visibleWhere(pb: Params, shopId: string, versionId: string, alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `${p}shop_id = ${pb.add(shopId)}::uuid AND ${p}index_version_id = ${pb.add(versionId)}::uuid
    AND ${p}published = true AND ${p}status = 'ACTIVE'`;
}

/**
 * Resolve ONE validated ref to a visible product id in the active version.
 * Returns null when the ref is invalid or does not map to a visible product.
 * Used by the beacon so a signal is only ever recorded for a real product.
 */
async function resolveOneVisible(
  exec: Exec,
  shopId: string,
  versionId: string,
  ref: ProductRef,
): Promise<string | null> {
  const pb = new Params();
  const { uuids, gids, handles } = partitionRefs([ref]);
  const ors: string[] = [];
  if (uuids.length) ors.push(`product_id = ANY(${pb.add(uuids)}::uuid[])`);
  if (gids.length) ors.push(`shopify_product_gid = ANY(${pb.add(gids)}::text[])`);
  if (handles.length) ors.push(`doc->>'handle' = ANY(${pb.add(handles)}::text[])`);
  if (ors.length === 0) return null;
  const sid = pb.add(shopId);
  const vid = pb.add(versionId);
  const rows = await exec.rows<{ product_id: string }>(
    `SELECT product_id FROM product_search_doc
     WHERE shop_id = ${sid}::uuid AND index_version_id = ${vid}::uuid
       AND published = true AND status = 'ACTIVE' AND (${ors.join(" OR ")})
     LIMIT 1`,
    pb.values,
  );
  return rows[0]?.product_id ?? null;
}

/**
 * Record ONE aggregate signal (view or click) for a product ref. Validates the
 * ref and the type BEFORE any SQL; resolves the ref to a visible product;
 * increments the per-UTC-day counter. Returns true when a counter was
 * incremented, false otherwise. NEVER throws — a hostile/junk beacon is a
 * no-op, never a 500.
 */
export async function recordSignal(
  exec: Exec,
  shopId: string,
  versionId: string | null,
  rawRef: unknown,
  rawType: unknown,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    if (!versionId) return false;
    const type = rawType === "view" || rawType === "click" ? (rawType as SignalType) : null;
    if (!type) return false;
    const ref = classifyRef(rawRef);
    if (!ref) return false;
    const productId = await resolveOneVisible(exec, shopId, versionId, ref);
    if (!productId) return false;
    const col = type === "click" ? "clicks" : "views";
    const pb = new Params();
    const sid = pb.add(shopId);
    const pid = pb.add(productId);
    const ts = pb.add(now.toISOString());
    await exec.run(
      `INSERT INTO product_signal_daily (shop_id, product_id, day, ${col}, updated_at)
       VALUES (${sid}::uuid, ${pid}::uuid, ((${ts}::timestamptz) AT TIME ZONE 'UTC')::date, 1, now())
       ON CONFLICT (shop_id, product_id, day)
       DO UPDATE SET ${col} = product_signal_daily.${col} + 1, updated_at = now()`,
      pb.values,
    );
    return true;
  } catch {
    return false;
  }
}

function clampHalfLife(d: number): number {
  const v = Math.floor(Number(d));
  if (!Number.isFinite(v) || v < 1) return DEFAULT_HALF_LIFE_DAYS;
  return v > 90 ? 90 : v;
}

function mapCard(row: any, score: number): ContentCard {
  const d = row.doc ?? {};
  const img = d.image ?? {};
  return {
    id: row.product_id, gid: row.gid, title: d.title ?? null, handle: d.handle ?? null,
    url: d.url ?? null, vendor: d.vendor ?? null, productType: d.productType ?? null,
    image: { url: img.url ?? null, alt: img.alt ?? null },
    priceMin: d.priceMin != null ? String(d.priceMin) : null,
    priceMax: d.priceMax != null ? String(d.priceMax) : null,
    compareAtMin: d.compareAtMin != null ? String(d.compareAtMin) : null,
    compareAtMax: d.compareAtMax != null ? String(d.compareAtMax) : null,
    available: Boolean(d.available), score,
  };
}

export interface TrendingOptions {
  limit: number;
  includeOutOfStock: boolean;
  hideIds: string[];
  excludeProductIds?: string[];
  halfLifeDays: number;
  now?: Date;
}

/** Common candidate filters (visibility + OOS policy + hide + exclusions). */
function candidateFilters(pb: Params, opts: TrendingOptions, alias = "d"): string[] {
  const parts: string[] = [];
  if (!opts.includeOutOfStock) parts.push(`${alias}.available = true`);
  if (opts.hideIds.length > 0) parts.push(`${alias}.product_id <> ALL(${pb.add(opts.hideIds)}::uuid[])`);
  if (opts.excludeProductIds && opts.excludeProductIds.length > 0) {
    parts.push(`${alias}.product_id <> ALL(${pb.add(opts.excludeProductIds)}::uuid[])`);
  }
  return parts;
}

/** Products with a positive time-decayed signal score, ranked. */
async function trendingScored(
  exec: Exec, shopId: string, versionId: string, opts: TrendingOptions,
): Promise<ContentCard[]> {
  const now = opts.now ?? new Date();
  const halfLife = clampHalfLife(opts.halfLifeDays);
  const pb = new Params();
  const vis = visibleWhere(pb, shopId, versionId, "d");
  const pNow = pb.add(now.toISOString());
  const pHalf = pb.add(halfLife);
  const pView = pb.add(VIEW_WEIGHT);
  const pClick = pb.add(CLICK_WEIGHT);
  const extra = candidateFilters(pb, opts, "d");
  const pLimit = pb.add(Math.max(1, Math.floor(opts.limit)));
  const sql = `
    SELECT d.product_id, d.shopify_product_gid AS gid, d.doc,
      SUM(
        (s.views * ${pView}::numeric + s.clicks * ${pClick}::numeric)
        * power(0.5, ((((${pNow}::timestamptz) AT TIME ZONE 'UTC')::date - s.day))::numeric / ${pHalf}::numeric)
      ) AS score
    FROM product_search_doc d
    JOIN product_signal_daily s ON s.shop_id = d.shop_id AND s.product_id = d.product_id
    WHERE ${vis}${extra.length ? " AND " + extra.join(" AND ") : ""}
    GROUP BY d.product_id, d.shopify_product_gid, d.doc, d.title
    HAVING SUM(
        (s.views * ${pView}::numeric + s.clicks * ${pClick}::numeric)
        * power(0.5, ((((${pNow}::timestamptz) AT TIME ZONE 'UTC')::date - s.day))::numeric / ${pHalf}::numeric)
      ) > 0
    ORDER BY score DESC, d.title ASC, d.product_id ASC
    LIMIT ${pLimit}::int`;
  const rows = await exec.rows<any>(sql, pb.values);
  return rows.map((r) => mapCard(r, Number(r.score)));
}

/** Deterministic no-signal fallback: newest visible products. */
async function newestFallback(
  exec: Exec, shopId: string, versionId: string, opts: TrendingOptions, exclude: string[],
): Promise<ContentCard[]> {
  const pb = new Params();
  const vis = visibleWhere(pb, shopId, versionId, "d");
  const extra = candidateFilters(pb, opts, "d");
  const allExcl = exclude.slice();
  if (allExcl.length > 0) extra.push(`d.product_id <> ALL(${pb.add(allExcl)}::uuid[])`);
  const pLimit = pb.add(Math.max(1, Math.floor(opts.limit)));
  const sql = `
    SELECT d.product_id, d.shopify_product_gid AS gid, d.doc
    FROM product_search_doc d
    WHERE ${vis}${extra.length ? " AND " + extra.join(" AND ") : ""}
    ORDER BY d.created_at_shopify DESC NULLS LAST, d.title ASC, d.product_id ASC
    LIMIT ${pLimit}::int`;
  const rows = await exec.rows<any>(sql, pb.values);
  return rows.map((r) => mapCard(r, 0));
}

/**
 * Trending shelf: signal-ranked products, topped up with newest visible
 * products when signals cover fewer than `limit`. When NO product has a signal,
 * the whole shelf is the newest-visible fallback. Deterministic throughout.
 */
export async function trending(
  exec: Exec, shopId: string, versionId: string, opts: TrendingOptions,
): Promise<ContentCard[]> {
  const limit = Math.max(1, Math.floor(opts.limit));
  const scored = await trendingScored(exec, shopId, versionId, opts);
  if (scored.length >= limit) return scored.slice(0, limit);
  const have = new Set(scored.map((c) => c.id));
  const topUp = await newestFallback(
    exec, shopId, versionId, { ...opts, limit: limit - scored.length }, [...have],
  );
  return scored.concat(topUp).slice(0, limit);
}
