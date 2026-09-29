import type { Exec } from "~/lib/db/executor";

/**
 * Catalog persistence. RLS-bound (caller runs inside withShop/withShopExec).
 *
 * Hardening (Phase 2.1):
 *  - Monotonic upserts: a row is only updated when the incoming
 *    shopify_updated_at is >= the stored one (via ON CONFLICT ... WHERE). This
 *    ignores stale/out-of-order events and never un-deletes from a stale event.
 *  - Soft delete advances shopify_updated_at (monotonic tombstone) so a later
 *    stale upsert cannot resurrect the row.
 *  - Explicit parameter casts ($1::uuid, ::jsonb, ::timestamptz) so the
 *    production Prisma raw-SQL path binds identically to node-postgres.
 *  - Set-based reconciliation and membership (no per-row round trips).
 */

export interface ProductInput {
  shopifyProductGid: string;
  handle?: string | null;
  title?: string | null;
  description?: string | null;
  vendor?: string | null;
  productType?: string | null;
  status?: string | null;
  tags?: string[];
  options?: unknown[];
  totalInventory?: number | null;
  tracksInventory?: boolean | null;
  featuredImageUrl?: string | null;
  featuredImageAlt?: string | null;
  onlineStoreUrl?: string | null;
  /** Flat { "namespace.key": value } map for the configured facet namespace. */
  metafields?: Record<string, string>;
  shopifyUpdatedAt?: string | Date | null;
}

export interface VariantInput {
  shopifyVariantGid: string;
  sku?: string | null;
  barcode?: string | null;
  title?: string | null;
  price?: number | string | null;
  compareAtPrice?: number | string | null;
  position?: number | null;
  selectedOptions?: unknown[];
  availableForSale?: boolean | null;
  shopifyUpdatedAt?: string | Date | null;
}

export interface CollectionInput {
  shopifyCollectionGid: string;
  handle?: string | null;
  title?: string | null;
  description?: string | null;
  shopifyUpdatedAt?: string | Date | null;
}

export interface UpsertResult {
  id: string;
  applied: boolean;
}

const toDate = (v?: string | Date | null): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(v);

export async function upsertProduct(
  exec: Exec,
  shopId: string,
  p: ProductInput,
): Promise<UpsertResult> {
  const params = [
    shopId,
    p.shopifyProductGid,
    p.handle ?? null,
    p.title ?? null,
    p.description ?? null,
    p.vendor ?? null,
    p.productType ?? null,
    p.status ?? null,
    JSON.stringify(p.tags ?? []),
    JSON.stringify(p.options ?? []),
    p.totalInventory ?? null,
    p.tracksInventory ?? null,
    toDate(p.shopifyUpdatedAt),
    p.featuredImageUrl ?? null,
    p.featuredImageAlt ?? null,
    p.onlineStoreUrl ?? null,
    JSON.stringify(p.metafields ?? {}),
  ];
  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO product
      (shop_id, shopify_product_gid, handle, title, description, vendor,
       product_type, status, tags, options, total_inventory, tracks_inventory,
       shopify_updated_at, featured_image_url, featured_image_alt, online_store_url,
       metafields, updated_at, deleted_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::int,$12::boolean,$13::timestamptz,
       $14,$15,$16,$17::jsonb, now(), NULL)
     ON CONFLICT (shop_id, shopify_product_gid) DO UPDATE SET
       handle=EXCLUDED.handle, title=EXCLUDED.title, description=EXCLUDED.description,
       vendor=EXCLUDED.vendor, product_type=EXCLUDED.product_type, status=EXCLUDED.status,
       tags=EXCLUDED.tags, options=EXCLUDED.options,
       total_inventory=EXCLUDED.total_inventory, tracks_inventory=EXCLUDED.tracks_inventory,
       featured_image_url=EXCLUDED.featured_image_url, featured_image_alt=EXCLUDED.featured_image_alt,
       online_store_url=EXCLUDED.online_store_url, metafields=EXCLUDED.metafields,
       shopify_updated_at=EXCLUDED.shopify_updated_at, updated_at=now(), deleted_at=NULL
     WHERE product.shopify_updated_at IS NULL
        OR EXCLUDED.shopify_updated_at IS NULL
        OR EXCLUDED.shopify_updated_at >= product.shopify_updated_at
     RETURNING id`,
    params,
  );
  if (rows[0]) return { id: rows[0].id, applied: true };
  // Conflict skipped by the monotonic guard: fetch the existing id.
  const existing = await exec.rows<{ id: string }>(
    `SELECT id FROM product WHERE shop_id=$1::uuid AND shopify_product_gid=$2`,
    [shopId, p.shopifyProductGid],
  );
  return { id: existing[0].id, applied: false };
}

export async function upsertVariant(
  exec: Exec,
  shopId: string,
  productId: string,
  v: VariantInput,
): Promise<string> {
  const params = [
    shopId,
    productId,
    v.shopifyVariantGid,
    v.sku ?? null,
    v.barcode ?? null,
    v.title ?? null,
    v.price ?? null,
    v.position ?? null,
    JSON.stringify(v.selectedOptions ?? []),
    v.availableForSale ?? null,
    toDate(v.shopifyUpdatedAt),
    v.compareAtPrice ?? null,
  ];
  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO variant
      (shop_id, product_id, shopify_variant_gid, sku, barcode, title, price,
       position, selected_options, available_for_sale, shopify_updated_at,
       compare_at_price, updated_at, deleted_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::numeric,$8::int,$9::jsonb,$10::boolean,$11::timestamptz,
       $12::numeric, now(), NULL)
     ON CONFLICT (shop_id, shopify_variant_gid) DO UPDATE SET
       product_id=EXCLUDED.product_id, sku=EXCLUDED.sku, barcode=EXCLUDED.barcode,
       title=EXCLUDED.title, price=EXCLUDED.price, position=EXCLUDED.position,
       selected_options=EXCLUDED.selected_options, available_for_sale=EXCLUDED.available_for_sale,
       compare_at_price=EXCLUDED.compare_at_price,
       shopify_updated_at=EXCLUDED.shopify_updated_at, updated_at=now(), deleted_at=NULL
     WHERE variant.shopify_updated_at IS NULL
        OR EXCLUDED.shopify_updated_at IS NULL
        OR EXCLUDED.shopify_updated_at >= variant.shopify_updated_at
     RETURNING id`,
    params,
  );
  if (rows[0]) return rows[0].id;
  const existing = await exec.rows<{ id: string }>(
    `SELECT id FROM variant WHERE shop_id=$1::uuid AND shopify_variant_gid=$2`,
    [shopId, v.shopifyVariantGid],
  );
  return existing[0].id;
}

/** Soft-delete variants of a product that are NOT in the incoming GID set. */
export async function reconcileProductVariants(
  exec: Exec,
  shopId: string,
  productId: string,
  keepVariantGids: string[],
): Promise<number> {
  return exec.run(
    `UPDATE variant SET deleted_at=now(), updated_at=now(), shopify_updated_at=now()
     WHERE shop_id=$1::uuid AND product_id=$2::uuid AND deleted_at IS NULL
       AND NOT (shopify_variant_gid = ANY($3::text[]))`,
    [shopId, productId, keepVariantGids],
  );
}

export async function upsertCollection(
  exec: Exec,
  shopId: string,
  c: CollectionInput,
): Promise<UpsertResult> {
  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO collection
      (shop_id, shopify_collection_gid, handle, title, description, shopify_updated_at, updated_at, deleted_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6::timestamptz, now(), NULL)
     ON CONFLICT (shop_id, shopify_collection_gid) DO UPDATE SET
       handle=EXCLUDED.handle, title=EXCLUDED.title, description=EXCLUDED.description,
       shopify_updated_at=EXCLUDED.shopify_updated_at, updated_at=now(), deleted_at=NULL
     WHERE collection.shopify_updated_at IS NULL
        OR EXCLUDED.shopify_updated_at IS NULL
        OR EXCLUDED.shopify_updated_at >= collection.shopify_updated_at
     RETURNING id`,
    [
      shopId,
      c.shopifyCollectionGid,
      c.handle ?? null,
      c.title ?? null,
      c.description ?? null,
      toDate(c.shopifyUpdatedAt),
    ],
  );
  if (rows[0]) return { id: rows[0].id, applied: true };
  const existing = await exec.rows<{ id: string }>(
    `SELECT id FROM collection WHERE shop_id=$1::uuid AND shopify_collection_gid=$2`,
    [shopId, c.shopifyCollectionGid],
  );
  return { id: existing[0].id, applied: false };
}

/** Replace a product's collection memberships from a set of collection GIDs (set-based). */
export async function replaceProductCollectionsByGids(
  exec: Exec,
  shopId: string,
  productId: string,
  collectionGids: string[],
): Promise<void> {
  // Insert memberships for any known collections in the set (single statement).
  await exec.run(
    `INSERT INTO product_collection (shop_id, product_id, collection_id)
     SELECT $1::uuid, $2::uuid, c.id
     FROM collection c
     WHERE c.shop_id=$1::uuid AND c.shopify_collection_gid = ANY($3::text[])
     ON CONFLICT (shop_id, product_id, collection_id) DO NOTHING`,
    [shopId, productId, collectionGids],
  );
  // Remove memberships whose collection is no longer in the set (single statement).
  await exec.run(
    `DELETE FROM product_collection pc
     USING collection c
     WHERE pc.shop_id=$1::uuid AND pc.product_id=$2::uuid
       AND c.id = pc.collection_id
       AND NOT (c.shopify_collection_gid = ANY($3::text[]))`,
    [shopId, productId, collectionGids],
  );
}

export async function softDeleteProductByGid(
  exec: Exec,
  shopId: string,
  gid: string,
): Promise<number> {
  return exec.run(
    `UPDATE product SET deleted_at=now(), updated_at=now(), shopify_updated_at=now()
     WHERE shop_id=$1::uuid AND shopify_product_gid=$2 AND deleted_at IS NULL`,
    [shopId, gid],
  );
}

export async function softDeleteCollectionByGid(
  exec: Exec,
  shopId: string,
  gid: string,
): Promise<number> {
  return exec.run(
    `UPDATE collection SET deleted_at=now(), updated_at=now(), shopify_updated_at=now()
     WHERE shop_id=$1::uuid AND shopify_collection_gid=$2 AND deleted_at IS NULL`,
    [shopId, gid],
  );
}

/**
 * Full-sync reconciliation: soft-delete products absent from the snapshot,
 * BUT only rows last touched BEFORE the snapshot started. A product created or
 * updated by a webhook AFTER the bulk snapshot began (so it is legitimately
 * absent from the snapshot) has updated_at >= snapshotStartedAt and survives.
 */
export async function softDeleteProductsNotIn(
  exec: Exec,
  shopId: string,
  keepGids: string[],
  snapshotStartedAt: Date,
): Promise<number> {
  return exec.run(
    `UPDATE product SET deleted_at=now(), updated_at=now(), shopify_updated_at=now()
     WHERE shop_id=$1::uuid AND deleted_at IS NULL
       AND NOT (shopify_product_gid = ANY($2::text[]))
       AND updated_at < $3::timestamptz`,
    [shopId, keepGids, snapshotStartedAt],
  );
}

export async function softDeleteCollectionsNotIn(
  exec: Exec,
  shopId: string,
  keepGids: string[],
  snapshotStartedAt: Date,
): Promise<number> {
  return exec.run(
    `UPDATE collection SET deleted_at=now(), updated_at=now(), shopify_updated_at=now()
     WHERE shop_id=$1::uuid AND deleted_at IS NULL
       AND NOT (shopify_collection_gid = ANY($2::text[]))
       AND updated_at < $3::timestamptz`,
    [shopId, keepGids, snapshotStartedAt],
  );
}

/** Record a successful full sync so the scheduler can find shops needing one. */
export async function updateShopLastFullSync(
  exec: Exec,
  shopId: string,
): Promise<void> {
  await exec.run(
    `UPDATE shop SET last_full_sync_at=now(), updated_at=now() WHERE id=$1::uuid`,
    [shopId],
  );
}

export async function countLiveProducts(
  exec: Exec,
  shopId: string,
): Promise<number> {
  const rows = await exec.rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL`,
    [shopId],
  );
  return rows[0].n;
}
