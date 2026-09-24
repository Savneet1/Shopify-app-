import type { Exec } from "~/lib/db/executor";
import {
  upsertProduct,
  upsertVariant,
  upsertCollection,
  reconcileProductVariants,
  replaceProductCollectionsByGids,
  softDeleteProductByGid,
  softDeleteCollectionByGid,
  softDeleteProductsNotIn,
  softDeleteCollectionsNotIn,
  countLiveProducts,
  updateShopLastFullSync,
  type CollectionInput,
} from "~/lib/catalog/store";
import {
  parseProductsJsonl,
  parseCollectionsJsonl,
  countProductsInJsonl,
  type NormalizedProduct,
} from "~/lib/catalog/bulk-parse";
import { normalizeProductNode, normalizeCollectionNode } from "~/lib/catalog/normalize";
import {
  createIndexVersion,
  buildDocs,
  validateIndexVersion,
  activateIndexVersion,
  refreshDocInActiveVersion,
  refreshDocsForProducts,
  pruneOldVersions,
} from "~/lib/index/engine";
import {
  startSyncRun,
  completeSyncRun,
  failSyncRun,
  recordSyncFailure,
  recoverStaleRuns,
  updateSyncRunStats,
  isAlreadyRunning,
} from "~/lib/sync/store";

export type ShopRunner = <T>(shopId: string, fn: (exec: Exec) => Promise<T>) => Promise<T>;

/** Fetch a Shopify entity NODE by GID (Admin GraphQL). Returns null if it no
 * longer exists. Injectable so the incremental path is testable without a store. */
export type NodeFetcher = (shopId: string, gid: string) => Promise<any | null>;

const chunkSize = () => Number(process.env.SYNC_CHUNK_SIZE || 500);
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface FullSyncInput {
  productsJsonl: string;
  collectionsJsonl?: string;
  shopifyObjectCount?: number | null;
  jobId?: string | null;
  // Captured BEFORE the bulk operation begins; reconciliation only deletes rows
  // last touched before this instant (so webhook-created rows survive — G4).
  snapshotStartedAt?: string | Date | null;
}

export interface FullSyncResult {
  ok: boolean;
  syncRunId?: string;
  indexVersionId?: string;
  version?: number;
  productCount: number;
  docCount?: number;
  reason?: string;
  deleted?: { products: number; collections: number };
}

/** Persist one normalized product (+variants, reconcile, memberships) via exec.
 * Reconciliation is SKIPPED when the source view was truncated (G6), so a
 * partial re-fetch never deletes real variants/memberships. */
async function persistProduct(exec: Exec, shopId: string, np: NormalizedProduct): Promise<void> {
  const { id, applied } = await upsertProduct(exec, shopId, np.product);
  if (!applied) return; // stale event ignored
  for (const v of np.variants) await upsertVariant(exec, shopId, id, v);
  if (np.variantsComplete !== false) {
    await reconcileProductVariants(exec, shopId, id, np.variants.map((v) => v.shopifyVariantGid));
  }
  if (np.collectionsComplete !== false) {
    await replaceProductCollectionsByGids(exec, shopId, id, np.collectionGids);
  }
}

export async function runFullSync(
  runner: ShopRunner,
  shopId: string,
  input: FullSyncInput,
): Promise<FullSyncResult> {
  const collections: CollectionInput[] = input.collectionsJsonl
    ? parseCollectionsJsonl(input.collectionsJsonl)
    : [];
  const products = parseProductsJsonl(input.productsJsonl);
  const productCount = countProductsInJsonl(input.productsJsonl);
  // Reconciliation boundary: rows updated at/after this instant survive.
  const snapshotStartedAt = input.snapshotStartedAt
    ? new Date(input.snapshotStartedAt)
    : new Date();

  // Guard: never treat a missing/incomplete download as "0 products" (which
  // would reconcile-delete the whole catalog).
  if (productCount === 0 && (input.shopifyObjectCount ?? 0) > 0) {
    throw new Error(
      "full sync aborted: empty product result but Shopify reported objects (incomplete download)",
    );
  }

  // Single-running-sync guard (+ stale recovery).
  await runner(shopId, (e) => recoverStaleRuns(e, shopId));
  let syncRunId: string;
  try {
    syncRunId = await runner(shopId, (e) => startSyncRun(e, shopId, "bulk_full", input.jobId ?? null));
  } catch (err) {
    if (isAlreadyRunning(err)) {
      return { ok: false, productCount, reason: "already_running" };
    }
    throw err;
  }

  try {
    const priorLive = await runner(shopId, (e) => countLiveProducts(e, shopId));

    // Collections first (chunked).
    for (const group of chunk(collections, chunkSize())) {
      await runner(shopId, async (e) => {
        for (const c of group) await upsertCollection(e, shopId, c);
      });
    }
    const collectionGids = collections.map((c) => c.shopifyCollectionGid);

    // Products (chunked; each chunk one tenant transaction).
    const productGids: string[] = [];
    for (const group of chunk(products, chunkSize())) {
      await runner(shopId, async (e) => {
        for (const np of group) {
          await persistProduct(e, shopId, np);
          productGids.push(np.product.shopifyProductGid);
        }
      });
    }

    // Reconciliation: remove products/collections absent from the snapshot, but
    // only those last touched before the snapshot started (G4).
    const deletedProducts = await runner(shopId, (e) =>
      softDeleteProductsNotIn(e, shopId, productGids, snapshotStartedAt),
    );
    const deletedCollections = await runner(shopId, (e) =>
      softDeleteCollectionsNotIn(e, shopId, collectionGids, snapshotStartedAt),
    );

    // Large-deletion safety check (recorded, not fatal).
    const ratio = priorLive > 0 ? deletedProducts / priorLive : 0;
    const warning =
      deletedProducts >= 5 && ratio >= 0.5
        ? `large deletion: ${deletedProducts}/${priorLive} products removed (${Math.round(ratio * 100)}%)`
        : null;
    await runner(shopId, (e) =>
      updateSyncRunStats(e, shopId, syncRunId, {
        productCount,
        stats: { deletedProducts, deletedCollections, keptProducts: productGids.length, priorLive },
        warning,
      }),
    );

    // Versioned index rebuild.
    const version = await runner(shopId, (e) => createIndexVersion(e, shopId, "full", productCount));
    const docCount = await runner(shopId, (e) => buildDocs(e, shopId, version.id));
    const validation = await runner(shopId, (e) => validateIndexVersion(e, shopId, version.id, productCount));
    if (!validation.pass) {
      await runner(shopId, async (e) => {
        await recordSyncFailure(e, shopId, syncRunId, "validate", `indexed ${validation.indexedCount} of ${productCount}`);
        await failSyncRun(e, shopId, syncRunId, "index validation failed");
      });
      return { ok: false, syncRunId, productCount, reason: "validation_failed", deleted: { products: deletedProducts, collections: deletedCollections } };
    }
    await runner(shopId, (e) => activateIndexVersion(e, shopId, version.id));
    await runner(shopId, (e) => pruneOldVersions(e, shopId, 2));

    await runner(shopId, async (e) => {
      await completeSyncRun(e, shopId, syncRunId, {
        objectCount: input.shopifyObjectCount ?? null,
        indexVersionId: version.id,
      });
      await updateShopLastFullSync(e, shopId);
    });

    return {
      ok: true, syncRunId, indexVersionId: version.id, version: version.version,
      productCount, docCount, deleted: { products: deletedProducts, collections: deletedCollections },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await runner(shopId, async (e) => {
      await recordSyncFailure(e, shopId, syncRunId, "run", message);
      await failSyncRun(e, shopId, syncRunId, message);
    }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Incremental — direct apply (used by re-fetch path and tests)
// ---------------------------------------------------------------------------

export async function applyProductUpsert(
  runner: ShopRunner,
  shopId: string,
  np: NormalizedProduct,
): Promise<void> {
  await runner(shopId, async (e) => {
    const { id, applied } = await upsertProduct(e, shopId, np.product);
    if (applied) {
      for (const v of np.variants) await upsertVariant(e, shopId, id, v);
      if (np.variantsComplete !== false) {
        await reconcileProductVariants(e, shopId, id, np.variants.map((v) => v.shopifyVariantGid));
      }
      if (np.collectionsComplete !== false) {
        await replaceProductCollectionsByGids(e, shopId, id, np.collectionGids);
      }
    }
    await refreshDocInActiveVersion(e, shopId, id);
  });
}

export async function applyProductDeletion(
  runner: ShopRunner,
  shopId: string,
  shopifyProductGid: string,
): Promise<void> {
  await runner(shopId, async (e) => {
    const rows = await e.rows<{ id: string }>(
      `SELECT id FROM product WHERE shop_id=$1::uuid AND shopify_product_gid=$2`,
      [shopId, shopifyProductGid],
    );
    await softDeleteProductByGid(e, shopId, shopifyProductGid);
    if (rows[0]) await refreshDocInActiveVersion(e, shopId, rows[0].id);
  });
}

export async function applyCollectionUpsert(
  runner: ShopRunner,
  shopId: string,
  c: CollectionInput,
): Promise<void> {
  await runner(shopId, (e) => upsertCollection(e, shopId, c).then(() => undefined));
}

export async function applyCollectionDeletion(
  runner: ShopRunner,
  shopId: string,
  shopifyCollectionGid: string,
): Promise<void> {
  await runner(shopId, (e) =>
    softDeleteCollectionByGid(e, shopId, shopifyCollectionGid).then(() => undefined),
  );
}

// ---------------------------------------------------------------------------
// Incremental — re-fetch by GID (webhook "entity changed" notifications)
// ---------------------------------------------------------------------------

export async function applyProductChange(
  runner: ShopRunner,
  shopId: string,
  gid: string,
  fetchNode: NodeFetcher,
): Promise<"upserted" | "deleted"> {
  const node = await fetchNode(shopId, gid); // network, outside the tx
  if (!node) {
    await applyProductDeletion(runner, shopId, gid);
    return "deleted";
  }
  await applyProductUpsert(runner, shopId, normalizeProductNode(node));
  return "upserted";
}

export async function applyCollectionChange(
  runner: ShopRunner,
  shopId: string,
  gid: string,
  fetchNode: NodeFetcher,
): Promise<"upserted" | "deleted"> {
  const node = await fetchNode(shopId, gid);
  await runner(shopId, async (e) => {
    // Resolve the collection id (present for both upsert and delete).
    let collectionId: string | null = null;
    if (!node) {
      const rows = await e.rows<{ id: string }>(
        `SELECT id FROM collection WHERE shop_id=$1::uuid AND shopify_collection_gid=$2`,
        [shopId, gid],
      );
      collectionId = rows[0]?.id ?? null;
      await softDeleteCollectionByGid(e, shopId, gid);
    } else {
      const res = await upsertCollection(e, shopId, normalizeCollectionNode(node));
      collectionId = res.id;
    }
    // G7: a rename/delete changes collection titles embedded in member product
    // docs — refresh those docs in the active version (chunked).
    if (collectionId) {
      const members = await e.rows<{ product_id: string }>(
        `SELECT product_id FROM product_collection WHERE shop_id=$1::uuid AND collection_id=$2::uuid`,
        [shopId, collectionId],
      );
      const ids = members.map((m) => m.product_id);
      for (const grp of chunk(ids, chunkSize())) {
        await refreshDocsForProducts(e, shopId, grp);
      }
    }
  });
  return node ? "upserted" : "deleted";
}
