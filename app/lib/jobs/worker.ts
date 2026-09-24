import type { PgBoss } from "pg-boss";
import { QUEUE, ensureQueues } from "./queue";
import {
  handleCatalogSyncFull,
  handleCatalogIncremental,
  type FullSyncJob,
  type IncrementalJob,
} from "./handlers";
import { withShopExec } from "~/lib/tenant.server";
import {
  fetchBulkCatalog,
  fetchProductNode,
  fetchCollectionNode,
} from "~/lib/shopify/bulk.server";
import { enqueueFullSync } from "./queue";
import { runReconciliationTick } from "./maintenance";
import { prismaRootExec } from "~/lib/db/root-exec.server";
import { logger } from "~/lib/logger.server";

/**
 * Background worker bootstrap. Registers pg-boss work handlers with real
 * dependencies. Concurrency is bounded; per-shop serialisation of full syncs is
 * enforced by the enqueue singletonKey. Retry/backoff/dead-letter come from the
 * queue configuration in queue.ts. On restart, in-flight jobs are re-delivered
 * by pg-boss, and interrupted index builds are recovered inside the full-sync
 * handler before rebuilding — so a crash never leaves a corrupt active index.
 *
 * Run as a separate process: `node ./build/worker.js` (see docs).
 */
export async function startWorker(): Promise<PgBoss> {
  const boss = await ensureQueues();
  const concurrency = Number(process.env.WORKER_CONCURRENCY || 2);

  await boss.work<FullSyncJob>(
    QUEUE.catalogSyncFull,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await handleCatalogSyncFull(job.data, {
          runner: withShopExec,
          fetchBulkCatalog,
        });
      }
    },
  );

  await boss.work<IncrementalJob>(
    QUEUE.catalogIncremental,
    { batchSize: concurrency },
    async (jobs) => {
      for (const job of jobs) {
        await handleCatalogIncremental(job.data, {
          runner: withShopExec,
          fetchProductNode,
          fetchCollectionNode,
        });
      }
    },
  );

  // Scheduled reconciliation (G8): enqueue a full sync for installed shops not
  // synced within RECONCILE_INTERVAL. Cron + interval configurable via env.
  await boss.work(QUEUE.maintenanceReconcile, async () => {
    const n = await runReconciliationTick(
      prismaRootExec(),
      (shopId) => enqueueFullSync(shopId),
      process.env.RECONCILE_INTERVAL || "24 hours",
    );
    logger.info({ enqueued: n }, "reconciliation tick");
  });
  await boss.schedule(
    QUEUE.maintenanceReconcile,
    process.env.RECONCILE_CRON || "0 * * * *",
    {},
    {},
  );

  logger.info("catalog worker started");
  return boss;
}
