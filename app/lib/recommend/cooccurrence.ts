import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { classifyRef } from "./refs";
import { resolveRefsToProductIds, type ContentCard } from "./content";

/**
 * Phase 9.3 — Frequently-Bought-Together via product co-occurrence.
 *
 * SCOPE NOTE (important): a REAL FBT source needs Shopify ORDER data
 * (read_orders, and possibly protected customer data / read_all_orders) — that
 * scope is NOT approved in Phase 9 and NO Shopify orders are read here. This
 * module implements the full, tested ALGORITHM and the storage, driven by an
 * abstract {@link BasketSource}. No real source is wired: a
 * {@link SyntheticBasketSource} exists for tests only. With no co-occurrence
 * data, FBT returns [] (and the API degrades to related products when the
 * merchant enables that fallback). Enabling real FBT = Requires Verification.
 *
 * Model (migration 0011): canonical unordered pairs in product_cooccurrence with
 * product_a <= product_b; a=b rows hold single-item SUPPORT, a<b rows hold the
 * pair co-occurrence count. product_cooccurrence_build holds the basket count N
 * (for the optional lift ranking) and build bookkeeping.
 *
 * Ranking (documented, deterministic):
 *   support     = co-occurrence count of (seed, candidate)              [= pair_count]
 *   confidence  = pair_count / support(seed)                            [P(cand | seed)]
 *   lift        = pair_count · N / (support(seed) · support(candidate)) [association strength]
 * A candidate must clear BOTH minSupport (on pair_count) and minConfidence;
 * results are ordered by the chosen metric DESC with a deterministic tie-break
 * (title ASC, then product_id ASC). The rebuild is idempotent (full replace).
 */

export const DEFAULT_MIN_SUPPORT = 2;
export const DEFAULT_MIN_CONFIDENCE = 0.1;
export const DEFAULT_MAX_BASKET_SIZE = 50;

export type FbtRanking = "confidence" | "lift";

/** A source of purchase baskets. Each basket is a list of product refs
 * (handles / gids / uuids); order within a basket is irrelevant. Deliberately
 * abstract so no order-reading code lives here. */
export interface BasketSource {
  baskets(): AsyncIterable<string[]>;
}

/** Test-only in-memory basket source (NEVER wired to real data). */
export class SyntheticBasketSource implements BasketSource {
  constructor(private readonly data: string[][]) {}
  async *baskets(): AsyncIterable<string[]> {
    for (const b of this.data) yield b;
  }
}

export interface RebuildOptions {
  maxBasketSize?: number;
  /** Label stored in product_cooccurrence_build.source (e.g. 'synthetic'). */
  sourceLabel?: string;
}

export interface RebuildResult {
  basketCount: number;
  itemCount: number;
  pairCount: number;
}

/**
 * Rebuild the co-occurrence table for a shop from a BasketSource. Idempotent:
 * the shop's rows are fully replaced, so re-running over the same source yields
 * the same table. Refs are resolved to VISIBLE product ids in the given version
 * (unresolved refs are dropped); baskets larger than maxBasketSize are ignored
 * (cost + noise bound); de-duplicated within a basket; baskets with < 2 distinct
 * resolved products count toward N and single-item support but create no pairs.
 */
export async function rebuildCooccurrence(
  exec: Exec,
  shopId: string,
  versionId: string,
  source: BasketSource,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const maxBasket = Math.max(2, Math.floor(opts.maxBasketSize ?? DEFAULT_MAX_BASKET_SIZE));
  const support = new Map<string, number>();
  const pairs = new Map<string, number>(); // key "a|b" with a < b
  let basketCount = 0;

  for await (const rawBasket of source.baskets()) {
    // Validate + resolve to visible product ids; dedupe within the basket.
    const refs = (rawBasket ?? [])
      .map((r) => classifyRef(r))
      .filter((r): r is NonNullable<typeof r> => r != null);
    if (refs.length === 0) continue;
    const resolved = await resolveRefsToProductIds(exec, shopId, versionId, refs);
    const ids = Array.from(new Set(resolved));
    if (ids.length === 0) continue;
    if (ids.length > maxBasket) continue; // oversized basket ignored entirely
    basketCount += 1;
    // deterministic canonical ordering
    ids.sort();
    for (const id of ids) support.set(id, (support.get(id) ?? 0) + 1);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}|${ids[j]}`; // ids[i] < ids[j] (sorted, distinct)
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  // Idempotent full replace, inside the caller's tenant transaction.
  await exec.run(`DELETE FROM product_cooccurrence WHERE shop_id = $1::uuid`, [shopId]);

  // Support rows (a = b).
  for (const [id, sup] of support) {
    await exec.run(
      `INSERT INTO product_cooccurrence (shop_id, product_a, product_b, pair_count, last_updated)
       VALUES ($1::uuid, $2::uuid, $2::uuid, $3::bigint, now())`,
      [shopId, id, sup],
    );
  }
  // Pair rows (a < b).
  for (const [key, cnt] of pairs) {
    const [a, b] = key.split("|");
    await exec.run(
      `INSERT INTO product_cooccurrence (shop_id, product_a, product_b, pair_count, last_updated)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, now())`,
      [shopId, a, b, cnt],
    );
  }

  await exec.run(
    `INSERT INTO product_cooccurrence_build (shop_id, basket_count, source, built_at)
     VALUES ($1::uuid, $2::bigint, $3, now())
     ON CONFLICT (shop_id) DO UPDATE SET basket_count = EXCLUDED.basket_count, source = EXCLUDED.source, built_at = now()`,
    [shopId, basketCount, opts.sourceLabel ?? "synthetic"],
  );

  return { basketCount, itemCount: support.size, pairCount: pairs.size };
}

export interface FbtOptions {
  limit: number;
  minSupport: number;
  minConfidence: number;
  ranking: FbtRanking;
  includeOutOfStock: boolean;
  hideIds: string[];
  excludeProductIds?: string[];
}

/**
 * Frequently-bought-together for a seed ref. Returns [] when the seed does not
 * resolve to a visible product, when there is no co-occurrence data, or when no
 * candidate clears minSupport/minConfidence. Only visible products are returned.
 */
export async function frequentlyBoughtTogether(
  exec: Exec,
  shopId: string,
  versionId: string,
  seedRef: unknown,
  opts: FbtOptions,
): Promise<ContentCard[]> {
  const ref = classifyRef(seedRef);
  if (!ref) return [];
  const [seedId] = await resolveRefsToProductIds(exec, shopId, versionId, [ref]);
  if (!seedId) return [];

  const minSupport = Math.max(1, Math.floor(opts.minSupport));
  const minConfidence = Number.isFinite(opts.minConfidence) ? Math.max(0, opts.minConfidence) : 0;
  const limit = Math.max(1, Math.floor(opts.limit));
  const ranking: FbtRanking = opts.ranking === "lift" ? "lift" : "confidence";

  const pb = new Params();
  const pSeed = pb.add(seedId);
  const pShop = pb.add(shopId);
  const pVer = pb.add(versionId);
  const pMinSup = pb.add(minSupport);
  const pMinConf = pb.add(minConfidence);

  const candFilters: string[] = [];
  if (!opts.includeOutOfStock) candFilters.push(`d.available = true`);
  if (opts.hideIds.length > 0) candFilters.push(`d.product_id <> ALL(${pb.add(opts.hideIds)}::uuid[])`);
  if (opts.excludeProductIds && opts.excludeProductIds.length > 0) {
    candFilters.push(`d.product_id <> ALL(${pb.add(opts.excludeProductIds)}::uuid[])`);
  }

  const metric = ranking === "lift"
    ? `(p.pair_count::numeric * COALESCE(nn.basket_count,0) / NULLIF(ss.sup * COALESCE(osup.pair_count,0), 0))`
    : `(p.pair_count::numeric / NULLIF(ss.sup, 0))`;

  const pLimit = pb.add(limit);
  const sql = `
    WITH nn AS (SELECT basket_count FROM product_cooccurrence_build WHERE shop_id = ${pShop}::uuid),
    ss AS (
      SELECT pair_count AS sup FROM product_cooccurrence
      WHERE shop_id = ${pShop}::uuid AND product_a = ${pSeed}::uuid AND product_b = ${pSeed}::uuid
    ),
    pairs AS (
      SELECT CASE WHEN product_a = ${pSeed}::uuid THEN product_b ELSE product_a END AS other, pair_count
      FROM product_cooccurrence
      WHERE shop_id = ${pShop}::uuid AND product_a <> product_b
        AND (product_a = ${pSeed}::uuid OR product_b = ${pSeed}::uuid)
    )
    SELECT d.product_id, d.shopify_product_gid AS gid, d.doc,
           p.pair_count,
           (p.pair_count::numeric / NULLIF(ss.sup, 0)) AS confidence,
           ${metric} AS metric
    FROM pairs p
    JOIN product_search_doc d
      ON d.shop_id = ${pShop}::uuid AND d.index_version_id = ${pVer}::uuid
         AND d.product_id = p.other AND d.published = true AND d.status = 'ACTIVE'
    CROSS JOIN ss
    LEFT JOIN nn ON true
    LEFT JOIN product_cooccurrence osup
      ON osup.shop_id = ${pShop}::uuid AND osup.product_a = p.other AND osup.product_b = p.other
    WHERE p.pair_count >= ${pMinSup}::bigint
      AND ss.sup IS NOT NULL
      AND (p.pair_count::numeric / NULLIF(ss.sup, 0)) >= ${pMinConf}::numeric
      ${candFilters.length ? "AND " + candFilters.join(" AND ") : ""}
    ORDER BY metric DESC NULLS LAST, d.title ASC, d.product_id ASC
    LIMIT ${pLimit}::int`;

  const rows = await exec.rows<any>(sql, pb.values);
  return rows.map((r) => {
    const d = r.doc ?? {};
    const img = d.image ?? {};
    return {
      id: r.product_id, gid: r.gid, title: d.title ?? null, handle: d.handle ?? null,
      url: d.url ?? null, vendor: d.vendor ?? null, productType: d.productType ?? null,
      image: { url: img.url ?? null, alt: img.alt ?? null },
      priceMin: d.priceMin != null ? String(d.priceMin) : null,
      priceMax: d.priceMax != null ? String(d.priceMax) : null,
      compareAtMin: d.compareAtMin != null ? String(d.compareAtMin) : null,
      compareAtMax: d.compareAtMax != null ? String(d.compareAtMax) : null,
      available: Boolean(d.available), score: Number(r.metric),
    } as ContentCard;
  });
}
