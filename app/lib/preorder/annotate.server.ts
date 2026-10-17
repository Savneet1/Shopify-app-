import type { Exec } from "~/lib/db/executor";
import { loadEnabledPreorderRules, preorderForProduct, type PreorderBadge, type PreorderProduct } from "./rules";
import { classifyRef } from "~/lib/recommend/refs";

/**
 * Phase 12.4 — compute pre-order badges for a set of products in one request.
 * Returns an EMPTY map when the shop has no enabled rules, so a shop that uses
 * no pre-order messaging adds nothing to any card payload (byte-identical).
 *
 * The product fields (gid, handle, tags, collection gids) come from the catalog
 * tables (same source as the index), not from the client.
 */
export async function annotatePreorder(
  exec: Exec, shopId: string, productIds: string[], now: Date,
): Promise<Map<string, PreorderBadge>> {
  const out = new Map<string, PreorderBadge>();
  if (productIds.length === 0) return out;
  const rules = await loadEnabledPreorderRules(exec, shopId);
  if (rules.length === 0) return out; // byte-identical: no rules → no annotation

  const rows = await exec.rows<{
    id: string; gid: string; handle: string | null; tags: any; collection_gids: string[] | null;
  }>(
    `SELECT p.id, p.shopify_product_gid AS gid, p.handle, p.tags,
            COALESCE(array_agg(c.shopify_collection_gid) FILTER (WHERE c.shopify_collection_gid IS NOT NULL), '{}') AS collection_gids
     FROM product p
     LEFT JOIN product_collection pc ON pc.product_id=p.id AND pc.shop_id=p.shop_id
     LEFT JOIN collection c ON c.id=pc.collection_id AND c.shop_id=p.shop_id AND c.deleted_at IS NULL
     WHERE p.shop_id=$1::uuid AND p.id = ANY($2::uuid[])
     GROUP BY p.id, p.shopify_product_gid, p.handle, p.tags`,
    [shopId, productIds],
  );

  for (const r of rows) {
    const tags: string[] = Array.isArray(r.tags) ? r.tags.map((t: unknown) => String(t)) : [];
    const p: PreorderProduct = {
      gid: r.gid,
      handle: r.handle,
      tags,
      collectionGids: Array.isArray(r.collection_gids) ? r.collection_gids : [],
    };
    const badge = preorderForProduct(rules, p, now);
    if (badge) out.set(r.id, badge);
  }
  return out;
}

/**
 * Phase 12.4 — resolve the pre-order badge for ONE product ref (gid or handle),
 * for the storefront product block (/proxy/preorder). Resolves the product's
 * gid/handle/tags/collection memberships from the catalog (never the client).
 * Returns null when no enabled, in-window rule matches / no rules. Pure DB.
 */
export async function resolvePreorder(
  exec: Exec, shopId: string, productRef: string | null, now: Date,
): Promise<PreorderBadge | null> {
  if (!productRef) return null;
  const rules = await loadEnabledPreorderRules(exec, shopId);
  if (rules.length === 0) return null;
  const ref = classifyRef(productRef);
  if (!ref || (ref.kind !== "gid" && ref.kind !== "handle")) return null;
  const where = ref.kind === "gid" ? "p.shopify_product_gid=$2" : "lower(p.handle)=lower($2)";
  const rows = await exec.rows<{ gid: string; handle: string | null; tags: unknown; collection_gids: string[] | null }>(
    `SELECT p.shopify_product_gid AS gid, p.handle, p.tags,
            COALESCE(array_agg(c.shopify_collection_gid) FILTER (WHERE c.shopify_collection_gid IS NOT NULL), '{}') AS collection_gids
     FROM product p
     LEFT JOIN product_collection pc ON pc.product_id=p.id AND pc.shop_id=p.shop_id
     LEFT JOIN collection c ON c.id=pc.collection_id AND c.shop_id=p.shop_id AND c.deleted_at IS NULL
     WHERE p.shop_id=$1::uuid AND ${where} AND p.deleted_at IS NULL
     GROUP BY p.shopify_product_gid, p.handle, p.tags`,
    [shopId, ref.value],
  );
  const r = rows[0];
  if (!r) return null;
  const tags: string[] = Array.isArray(r.tags) ? r.tags.map((t: unknown) => String(t)) : [];
  const p: PreorderProduct = { gid: r.gid, handle: r.handle, tags, collectionGids: Array.isArray(r.collection_gids) ? r.collection_gids : [] };
  return preorderForProduct(rules, p, now);
}

/**
 * Additively attach a `preorder` badge to each product card that matches an
 * enabled rule. Mutates in place. NO-OP (and no attached field) when the shop
 * has no enabled pre-order rules — card payloads stay byte-identical.
 */
export async function attachPreorder<T extends { id: string }>(
  exec: Exec, shopId: string, products: T[], now: Date = new Date(),
): Promise<void> {
  if (products.length === 0) return;
  const map = await annotatePreorder(exec, shopId, products.map((p) => p.id), now);
  if (map.size === 0) return;
  for (const p of products) {
    const badge = map.get(p.id);
    if (badge) (p as unknown as { preorder?: unknown }).preorder = badge;
  }
}
