import { getPrisma } from "~/db.server";
import { QUEUE } from "./queue";

const ALL_QUEUES = [
  QUEUE.catalogSyncFull,
  QUEUE.catalogSyncFullDlq,
  QUEUE.catalogIncremental,
  QUEUE.catalogIncrementalDlq,
];

/**
 * Cancel/purge all of a shop's pg-boss jobs (active queues, dead-letter queues,
 * and archived rows) on uninstall / shop redaction. Jobs are matched by the
 * server-derived shopId in their payload. pg-boss tables are infrastructure (no
 * RLS); this runs as app_runtime which holds DML on the pgboss schema.
 */
export async function purgeShopJobs(shopId: string): Promise<void> {
  const schema = (process.env.BOSS_SCHEMA || "pgboss").replace(/[^a-zA-Z0-9_]/g, "");
  const p = getPrisma();
  await p.$executeRawUnsafe(
    `DELETE FROM ${schema}.job WHERE name = ANY($1::text[]) AND data->>'shopId' = $2`,
    ALL_QUEUES,
    shopId,
  );
  // The archive table exists in normal installs; guard in case of version drift.
  try {
    await p.$executeRawUnsafe(
      `DELETE FROM ${schema}.archive WHERE name = ANY($1::text[]) AND data->>'shopId' = $2`,
      ALL_QUEUES,
      shopId,
    );
  } catch {
    /* archive table absent — nothing to purge */
  }
}
