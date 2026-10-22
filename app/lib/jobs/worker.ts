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
import { enqueueFullSync, enqueueRestockDrain } from "./queue";
import { runReconciliationTick, runSignalRetention, runAnalyticsPartitionMaintenance, runRestockMaintenance, selectInstalledShops } from "./maintenance";
import { runRestockDrainForShop } from "~/lib/restock/drain.server";
import { runRestockConfirm } from "~/lib/restock/send.server";
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
        const res = await handleCatalogIncremental(job.data, {
          runner: withShopExec,
          fetchProductNode,
          fetchCollectionNode,
        });
        // Phase 12.3: after a product change, kick a per-shop restock drain
        // (singleton; a no-op when nothing is pending / email unconfigured).
        if (job.data.entity === "product" && "ok" in res) {
          await enqueueRestockDrain(job.data.shopId).catch(() => {});
        }
      }
    },
  );

  // Phase 12.3: per-shop back-in-stock notification drain (singleton per shop).
  await boss.work<{ shopId: string }>(QUEUE.restockDrain, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const r = await runRestockDrainForShop(job.data.shopId);
      logger.info({ shopId: job.data.shopId, ...r }, "restock drain");
    }
  });

  // Phase 12.1 Q2: async double-opt-in confirmation send (singleton per sub). A
  // throw here (transient) lets pg-boss retry; a worker failure never affects the
  // already-returned public HTTP response. Payload carries only opaque ids.
  await boss.work<{ shopId: string; subscriptionId: string }>(QUEUE.restockConfirm, { batchSize: 10 }, async (jobs) => {
    for (const job of jobs) {
      const r = await runRestockConfirm(job.data.shopId, job.data.subscriptionId);
      logger.info({ shopId: job.data.shopId, sent: r.sent, reason: r.reason }, "restock confirm");
    }
  });

  // Scheduled reconciliation (G8): enqueue a full sync for installed shops not
  // synced within RECONCILE_INTERVAL. Cron + interval configurable via env.
  await boss.work(QUEUE.maintenanceReconcile, async () => {
    const n = await runReconciliationTick(
      prismaRootExec(),
      (shopId) => enqueueFullSync(shopId),
      process.env.RECONCILE_INTERVAL || "24 hours",
    );
    // K2: same tick drains one bounded batch of expired trending/bundle/
    // analytics rows per installed shop (RLS-scoped, short locks). No new queue.
    const purged = await runSignalRetention(prismaRootExec(), withShopExec);
    // Phase 11: ensure analytics partitions ahead + drop ones past the hard cap
    // (owner definer functions, global/not per-shop).
    const parts = await runAnalyticsPartitionMaintenance(prismaRootExec());
    // Phase 12.7: back-in-stock retention (per shop, bounded batches, RLS).
    const restock = await runRestockMaintenance(prismaRootExec(), withShopExec);
    // Phase 12.3: backstop drain for every installed shop (singleton per shop;
    // a no-op when nothing is pending / email unconfigured).
    const shops = await selectInstalledShops(prismaRootExec());
    for (const id of shops) await enqueueRestockDrain(id).catch(() => {});
    logger.info(
      { enqueued: n, signalsPurged: purged, partitionsEnsured: parts.ensured.length, partitionsDropped: parts.dropped, restock },
      "reconciliation tick",
    );
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
