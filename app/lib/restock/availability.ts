import type { Exec } from "~/lib/db/executor";

/**
 * Phase 12.3 — availability-transition detection from the catalog data the app
 * ALREADY syncs (read_products only; no inventory scopes). On an
 * unavailable -> available transition we bump a per-target monotonic EPOCH; the
 * epoch is the idempotency key for notifications, so a webhook replay or a
 * re-detection of the same availability does not double-send.
 *
 * "Available" here is the SHOPPER-EFFECTIVE availability: the product must be a
 * VISIBLE doc in the ACTIVE index version (published + status ACTIVE) AND
 * purchasable (product-level any_available, or the specific variant's
 * available_for_sale). An unpublished/again-sold-out product is effective=false
 * and never triggers (and is re-checked again at send time).
 *
 * Monotonic guard (Phase 2.1): each state row records last_source_at = the
 * product's shopify_updated_at at detection. An out-of-order / stale signal
 * (older-or-equal source timestamp) is ignored, so a late "went unavailable"
 * cannot reset state and cause a spurious re-notification.
 */

export interface AvailabilityTransition {
  productId: string;
  variantKey: string; // '' = product-level; else the variant gid
  epoch: number;
}

export interface VisibleProduct {
  visible: boolean;
  available: boolean;   // effective availability for the given target (product or variant)
  gid: string | null;
  title: string | null;
  url: string | null;   // online_store_url from the visible doc (shop's own domain)
}

/**
 * Load the shopper-effective availability + display fields for a target
 * (product-level when variantKey==='') from the ACTIVE index version's VISIBLE
 * doc. Used for the SEND-TIME re-check and to source the email's title/URL from
 * the visible doc only. RLS-scoped via exec.
 */
export async function effectiveAvailability(
  exec: Exec, shopId: string, productId: string, variantKey: string,
): Promise<VisibleProduct> {
  const rows = await exec.rows<{ gid: string; title: string | null; url: string | null; available: boolean; published: boolean; status: string | null }>(
    `SELECT psd.shopify_product_gid AS gid, psd.title AS title, (psd.doc->>'url') AS url,
            psd.available, psd.published, psd.status
     FROM product_search_doc psd
     JOIN index_version iv ON iv.id=psd.index_version_id AND iv.status='active' AND iv.shop_id=psd.shop_id
     WHERE psd.shop_id=$1::uuid AND psd.product_id=$2::uuid`,
    [shopId, productId],
  );
  const r = rows[0];
  if (!r) return { visible: false, available: false, gid: null, title: null, url: null };
  const visible = r.published === true && r.status === "ACTIVE";
  let available = visible && r.available === true;
  if (visible && variantKey !== "") {
    available = await variantEffective(exec, shopId, productId, variantKey, visible);
  }
  return { visible, available, gid: r.gid, title: r.title, url: r.url };
}

/** Product-level effective availability + source timestamp from the active doc. */
async function productEffective(exec: Exec, shopId: string, productId: string): Promise<{ visible: boolean; available: boolean }> {
  const rows = await exec.rows<{ available: boolean; published: boolean; status: string | null }>(
    `SELECT psd.available, psd.published, psd.status
     FROM product_search_doc psd
     JOIN index_version iv ON iv.id=psd.index_version_id AND iv.status='active' AND iv.shop_id=psd.shop_id
     WHERE psd.shop_id=$1::uuid AND psd.product_id=$2::uuid`,
    [shopId, productId],
  );
  const r = rows[0];
  if (!r) return { visible: false, available: false };
  const visible = r.published === true && r.status === "ACTIVE";
  return { visible, available: visible && r.available === true };
}

async function sourceTimestamp(exec: Exec, shopId: string, productId: string): Promise<string | null> {
  const rows = await exec.rows<{ ts: string | null }>(
    `SELECT shopify_updated_at AS ts FROM product WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, productId],
  );
  return rows[0]?.ts ?? null;
}

/** Distinct variant_keys that currently have CONFIRMED subscriptions on this
 * product (so we only track availability for targets anyone is waiting on). */
async function subscribedVariantKeys(exec: Exec, shopId: string, productId: string): Promise<string[]> {
  const rows = await exec.rows<{ variant_key: string }>(
    `SELECT DISTINCT variant_key FROM back_in_stock_subscription
     WHERE shop_id=$1::uuid AND product_id=$2::uuid AND status='confirmed'`,
    [shopId, productId],
  );
  return rows.map((r) => r.variant_key);
}

async function variantEffective(
  exec: Exec, shopId: string, productId: string, variantGid: string, productVisible: boolean,
): Promise<boolean> {
  if (!productVisible) return false;
  const rows = await exec.rows<{ a: boolean | null }>(
    `SELECT available_for_sale AS a FROM variant
     WHERE shop_id=$1::uuid AND product_id=$2::uuid AND shopify_variant_gid=$3 AND deleted_at IS NULL`,
    [shopId, productId, variantGid],
  );
  return rows[0]?.a === true;
}

/** Upsert one availability-state row, applying the monotonic guard, and return
 * a transition (with the bumped epoch) when it flips unavailable -> available. */
async function applyState(
  exec: Exec, shopId: string, productId: string, variantKey: string,
  effectiveAvailable: boolean, sourceAt: string | null,
): Promise<AvailabilityTransition | null> {
  const prior = await exec.rows<{ available: boolean; epoch: number; last_source_at: string | null }>(
    `SELECT available, epoch, last_source_at FROM restock_availability
     WHERE shop_id=$1::uuid AND product_id=$2::uuid AND variant_key=$3`,
    [shopId, productId, variantKey],
  );
  const p = prior[0];

  // Monotonic guard: ignore a stale/out-of-order signal.
  if (p && sourceAt && p.last_source_at && new Date(sourceAt).getTime() <= new Date(p.last_source_at).getTime()) {
    return null;
  }

  const wasAvailable = p?.available === true;
  const transitioned = !wasAvailable && effectiveAvailable === true;
  const epoch = (p?.epoch ?? 0) + (transitioned ? 1 : 0);

  await exec.run(
    `INSERT INTO restock_availability (shop_id, product_id, variant_key, available, epoch, last_source_at, updated_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5::int,$6::timestamptz, now())
     ON CONFLICT (shop_id, product_id, variant_key) DO UPDATE
       SET available=EXCLUDED.available, epoch=EXCLUDED.epoch, last_source_at=EXCLUDED.last_source_at, updated_at=now()`,
    [shopId, productId, variantKey, effectiveAvailable, epoch, sourceAt],
  );

  return transitioned ? { productId, variantKey, epoch } : null;
}

/**
 * Record availability for a product (and its subscribed variants) and return
 * the unavailable->available transitions. Pure DB (RLS-scoped via exec); never
 * sends anything itself.
 */
export async function recordAvailabilityTransitions(
  exec: Exec, shopId: string, productId: string,
): Promise<AvailabilityTransition[]> {
  const sourceAt = await sourceTimestamp(exec, shopId, productId);
  const prod = await productEffective(exec, shopId, productId);
  const transitions: AvailabilityTransition[] = [];

  const t0 = await applyState(exec, shopId, productId, "", prod.available, sourceAt);
  if (t0) transitions.push(t0);

  for (const vk of await subscribedVariantKeys(exec, shopId, productId)) {
    if (vk === "") continue; // product-level handled above
    const avail = await variantEffective(exec, shopId, productId, vk, prod.visible);
    const t = await applyState(exec, shopId, productId, vk, avail, sourceAt);
    if (t) transitions.push(t);
  }
  return transitions;
}
