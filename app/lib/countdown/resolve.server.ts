import type { Exec } from "~/lib/db/executor";
import { loadEnabledCountdownRules, countdownForTarget, type CountdownPayload, type CountdownTarget } from "./rules";
import { classifyRef } from "~/lib/recommend/refs";

/**
 * Phase 12.5 — resolve the applicable countdown for a storefront request. A
 * global rule applies even when the product ref is unknown; product/collection
 * rules resolve the product's gid/handle/collection memberships from the catalog
 * (never from the client). Returns null (nothing shown) when no rule applies.
 */
export async function resolveCountdown(
  exec: Exec, shopId: string, productRef: string | null, now: Date,
): Promise<CountdownPayload | null> {
  const rules = await loadEnabledCountdownRules(exec, shopId);
  if (rules.length === 0) return null;

  let target: CountdownTarget = { gid: "", handle: null, collectionGids: [] };
  if (productRef) {
    const ref = classifyRef(productRef);
    if (ref && (ref.kind === "gid" || ref.kind === "handle")) {
      const where = ref.kind === "gid" ? "p.shopify_product_gid=$2" : "lower(p.handle)=lower($2)";
      const rows = await exec.rows<{ gid: string; handle: string | null; collection_gids: string[] | null }>(
        `SELECT p.shopify_product_gid AS gid, p.handle,
                COALESCE(array_agg(c.shopify_collection_gid) FILTER (WHERE c.shopify_collection_gid IS NOT NULL), '{}') AS collection_gids
         FROM product p
         LEFT JOIN product_collection pc ON pc.product_id=p.id AND pc.shop_id=p.shop_id
         LEFT JOIN collection c ON c.id=pc.collection_id AND c.shop_id=p.shop_id AND c.deleted_at IS NULL
         WHERE p.shop_id=$1::uuid AND ${where} AND p.deleted_at IS NULL
         GROUP BY p.shopify_product_gid, p.handle`,
        [shopId, ref.value],
      );
      if (rows[0]) {
        target = { gid: rows[0].gid, handle: rows[0].handle, collectionGids: rows[0].collection_gids ?? [] };
      } else if (ref.kind === "gid") {
        target = { gid: ref.value, handle: null, collectionGids: [] };
      }
    }
  }
  return countdownForTarget(rules, target, now);
}
