import { QUEUE } from "./queue";
import type { ShopRunner, NodeFetcher } from "~/lib/sync/orchestrator";
import {
  runFullSync,
  applyProductChange,
  applyCollectionChange,
} from "~/lib/sync/orchestrator";
import { beginJobAttempt, markJob } from "~/lib/sync/store";
import { recoverInterruptedBuilds } from "~/lib/index/engine";
import { isShopInstalled } from "~/lib/shop";

/**
 * Job handlers. Injected dependencies (runner + Shopify fetchers) so they are
 * testable without a live store. Idempotency via beginJobAttempt (retries of
 * unfinished jobs proceed; completed work is skipped). Jobs for uninstalled
 * shops are DROPPED (marked complete), never retried.
 */

export interface BulkFetchResult {
  productsJsonl: string;
  collectionsJsonl?: string;
  objectCount?: number | null;
  // Captured before the bulk operation began (G4 reconciliation boundary).
  snapshotStartedAt?: string | Date | null;
}

export interface FullSyncDeps {
  runner: ShopRunner;
  fetchBulkCatalog: (shopId: string) => Promise<BulkFetchResult>;
  /**
   * Phase 14d: refresh planner statistics on the build-output tables after a
   * successful full sync (owner-side ANALYZE; see analyze.server.ts). Optional +
   * best-effort — a missing or failing refresh never fails the sync (autovacuum
   * reloptions are the fallback). Injected so handler tests stay engine-free.
   */
  postBuildAnalyze?: () => Promise<unknown>;
}

export interface FullSyncJob {
  shopId: string;
  dedupeKey: string;
  jobId?: string | null;
}

export async function handleCatalogSyncFull(
  job: FullSyncJob,
  deps: FullSyncDeps,
): Promise<{ skipped: true; reason?: string } | { ok: true; version?: number; docCount?: number }> {
  const { shopId, dedupeKey } = job;
  const guard = await deps.runner(shopId, (e) =>
    beginJobAttempt(e, shopId, QUEUE.catalogSyncFull, dedupeKey, job.jobId ?? null),
  );
  if (!guard.proceed) return { skipped: true, reason: "duplicate" };

  const installed = await deps.runner(shopId, (e) => isShopInstalled(e, shopId));
  if (!installed) {
    await deps.runner(shopId, (e) => markJob(e, shopId, dedupeKey, "completed"));
    return { skipped: true, reason: "uninstalled" };
  }

  try {
    await deps.runner(shopId, (e) => recoverInterruptedBuilds(e, shopId));
    const fetched = await deps.fetchBulkCatalog(shopId);
    const res = await runFullSync(deps.runner, shopId, {
      productsJsonl: fetched.productsJsonl,
      collectionsJsonl: fetched.collectionsJsonl,
      shopifyObjectCount: fetched.objectCount ?? null,
      snapshotStartedAt: fetched.snapshotStartedAt ?? null,
      jobId: job.jobId ?? null,
    });
    if (!res.ok) {
      await deps.runner(shopId, (e) => markJob(e, shopId, dedupeKey, "failed", res.reason ?? "sync failed"));
      if (res.reason === "already_running") return { skipped: true, reason: "already_running" };
      throw new Error(`full sync failed: ${res.reason}`);
    }
    await deps.runner(shopId, (e) => markJob(e, shopId, dedupeKey, "completed"));
    // Phase 14d: the build just bulk-inserted docs and rebuilt the derived
    // structures, leaving pg_class.reltuples stale (-1) for product_search_doc.
    // Refresh statistics synchronously so the incremental delta write path uses
    // the unique index immediately, instead of waiting for async autovacuum.
    // Best-effort: never fails the completed sync.
    if (deps.postBuildAnalyze) {
      try { await deps.postBuildAnalyze(); } catch { /* non-fatal; autovacuum fallback */ }
    }
    return { ok: true, version: res.version, docCount: res.docCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.runner(shopId, (e) => markJob(e, shopId, dedupeKey, "failed", message)).catch(() => {});
    throw err;
  }
}

export interface IncrementalJob {
  shopId: string;
  dedupeKey: string;
  entity: "product" | "collection";
  gid: string;
}

export interface IncrementalDeps {
  runner: ShopRunner;
  fetchProductNode: NodeFetcher;
  fetchCollectionNode: NodeFetcher;
}

export async function handleCatalogIncremental(
  job: IncrementalJob,
  deps: IncrementalDeps,
): Promise<{ skipped: true; reason?: string } | { ok: true; result: string }> {
  const { shopId, dedupeKey } = job;
  const guard = await deps.runner(shopId, (e) =>
    beginJobAttempt(e, shopId, QUEUE.catalogIncremental, dedupeKey, null),
  );
  if (!guard.proceed) return { skipped: true, reason: "duplicate" };

  const installed = await deps.runner(shopId, (e) => isShopInstalled(e, shopId));
  if (!installed) {
    await deps.runner(shopId, (e) => markJob(e, shopId, dedupeKey, "completed"));
    return { skipped: true, reason: "uninstalled" };
  }

  try {
    const result =
      job.entity === "product"
        ? await applyProductChange(deps.runner, shopId, job.gid, deps.fetchProductNode)
        : await applyCollectionChange(deps.runner, shopId, job.gid, deps.fetchCollectionNode);
    await deps.runner(shopId, (e) => markJob(e, shopId, dedupeKey, "completed"));
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.runner(shopId, (e) => markJob(e, shopId, dedupeKey, "failed", message)).catch(() => {});
    throw err;
  }
}
