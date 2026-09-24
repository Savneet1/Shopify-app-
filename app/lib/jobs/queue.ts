import { PgBoss } from "pg-boss";

/**
 * pg-boss job queue (PostgreSQL-backed; no Redis). Queues carry retry + backoff
 * + dead-letter configuration. Job payloads always include a SERVER-DERIVED
 * shopId; handlers bind that shop via withShop, so a worker can never process
 * another shop's data from an untrusted identifier.
 *
 * pg-boss connects as app_runtime in its own `pgboss` schema (see migration
 * 0003). It is queue INFRASTRUCTURE; all tenant data access still goes through
 * RLS-bound withShop.
 */
export const QUEUE = {
  catalogSyncFull: "catalog-sync-full",
  catalogSyncFullDlq: "catalog-sync-full-dlq",
  catalogIncremental: "catalog-incremental",
  catalogIncrementalDlq: "catalog-incremental-dlq",
  maintenanceReconcile: "maintenance-reconcile",
} as const;

let boss: PgBoss | null = null;

export function getBoss(): PgBoss {
  if (boss) return boss;
  const connectionString =
    process.env.BOSS_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for pg-boss");
  boss = new PgBoss({
    connectionString,
    schema: process.env.BOSS_SCHEMA || "pgboss",
    // The app runs as app_runtime with migrate:false; the schema is installed
    // once by app_owner (`npm run pgboss:install`). Set BOSS_MIGRATE=true only
    // for a connection that is allowed to create/upgrade the pg-boss schema.
    migrate: process.env.BOSS_MIGRATE === "true",
  });
  return boss;
}

/** Start pg-boss and declare all queues (idempotent). */
export async function startQueues(instance?: PgBoss): Promise<PgBoss> {
  const b = instance ?? getBoss();
  if (instance) boss = instance;
  await b.start();

  // Dead-letter queues must exist before referencing them.
  await b.createQueue(QUEUE.catalogSyncFullDlq);
  await b.createQueue(QUEUE.catalogIncrementalDlq);

  // 'stately' = at most ONE queued AND ONE active job per singletonKey, so
  // repeated "Run full sync" clicks never pile up unbounded syncs for a shop
  // (one runs, at most one waits). A DB partial-unique index on
  // sync_run(shop_id) WHERE status='running' is the authoritative backstop.
  // expireInSeconds (40 min) exceeds the 30-min bulk poll timeout + processing,
  // so a slow-but-alive job is not re-delivered while still running.
  await b.createQueue(QUEUE.catalogSyncFull, {
    policy: "stately",
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 30,
    deadLetter: QUEUE.catalogSyncFullDlq,
    expireInSeconds: 2400,
  });
  await b.createQueue(QUEUE.maintenanceReconcile, { policy: "singleton" });
  await b.createQueue(QUEUE.catalogIncremental, {
    policy: "short",
    retryLimit: 8,
    retryBackoff: true,
    retryDelay: 2,
    deadLetter: QUEUE.catalogIncrementalDlq,
    expireInSeconds: 600,
  });
  return b;
}

let startedOnce: Promise<PgBoss> | null = null;

/** Memoised start+declare, so the web (sender) process starts pg-boss once.
 * A rejected start is NOT cached, so a transient failure can be retried. */
export function ensureQueues(): Promise<PgBoss> {
  if (!startedOnce) {
    startedOnce = startQueues().catch((err) => {
      startedOnce = null;
      throw err;
    });
  }
  return startedOnce;
}

export async function stopQueues(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: false });
    boss = null;
    startedOnce = null;
  }
}

/**
 * Enqueue a full catalog sync. singletonKey defaults to the shop id so at most
 * one full sync is queued/active per shop (matching Shopify's one-bulk-op
 * expectation). dedupeKey feeds the handler's idempotency guard.
 */
export async function enqueueFullSync(
  shopId: string,
  opts: { dedupeKey?: string; singletonKey?: string } = {},
): Promise<string | null> {
  const dedupeKey = opts.dedupeKey ?? `full-sync:${shopId}:${Date.now()}`;
  const b = await ensureQueues();
  return b.send(
    QUEUE.catalogSyncFull,
    { shopId, dedupeKey },
    { singletonKey: opts.singletonKey ?? `full-sync:${shopId}` },
  );
}

// Incremental jobs are "entity X changed" notifications. The worker re-fetches
// the entity by GID (same normalization as bulk) and applies it, or deletes it
// if it no longer exists. No payload data is trusted from the webhook body.
export interface IncrementalPayload {
  shopId: string;
  dedupeKey: string;
  entity: "product" | "collection";
  gid: string;
}

export async function enqueueIncremental(
  payload: IncrementalPayload,
): Promise<string | null> {
  const b = await ensureQueues();
  return b.send(QUEUE.catalogIncremental, payload, {
    singletonKey: payload.dedupeKey,
  });
}
