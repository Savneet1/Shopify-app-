import { getPrisma } from "~/db.server";
import { QUEUE, enqueueFullSync, enqueueIncremental, type IncrementalPayload } from "./queue";

/**
 * Read-only + retry helpers for the sync dashboard. All queries are filtered to
 * the current shop by the server-derived shopId in the job payload
 * (data->>'shopId'); the retry path re-verifies ownership before re-enqueuing.
 */
const DLQS = [QUEUE.catalogSyncFullDlq, QUEUE.catalogIncrementalDlq];
const schema = () => (process.env.BOSS_SCHEMA || "pgboss").replace(/[^a-zA-Z0-9_]/g, "");

export interface DeadLetter {
  id: string;
  name: string;
  created_on: string;
  data: any;
}

export async function listDeadLetters(shopId: string, limit = 20): Promise<DeadLetter[]> {
  const rows = (await getPrisma().$queryRawUnsafe(
    `SELECT id::text, name, created_on, data
     FROM ${schema()}.job
     WHERE name = ANY($1::text[]) AND data->>'shopId' = $2
     ORDER BY created_on DESC LIMIT $3`,
    DLQS,
    shopId,
    limit,
  )) as DeadLetter[];
  return rows;
}

export async function deadLetterCount(shopId: string): Promise<number> {
  const rows = (await getPrisma().$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM ${schema()}.job
     WHERE name = ANY($1::text[]) AND data->>'shopId' = $2`,
    DLQS,
    shopId,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Retry a dead-lettered job for THIS shop. Re-verifies ownership server-side
 * (the job's payload shopId must equal the authenticated shopId), re-enqueues
 * onto the live queue, then removes the DLQ row.
 */
export async function retryDeadLetter(shopId: string, jobId: string): Promise<boolean> {
  const rows = (await getPrisma().$queryRawUnsafe(
    `SELECT id::text, name, data FROM ${schema()}.job
     WHERE id = $1::uuid AND name = ANY($2::text[])`,
    jobId,
    DLQS,
  )) as Array<{ id: string; name: string; data: any }>;
  const job = rows[0];
  if (!job) return false;
  // Ownership re-verification — never act on another shop's job.
  if (job.data?.shopId !== shopId) return false;

  if (job.name === QUEUE.catalogSyncFullDlq) {
    await enqueueFullSync(shopId);
  } else {
    await enqueueIncremental(job.data as IncrementalPayload);
  }
  await getPrisma().$executeRawUnsafe(
    `DELETE FROM ${schema()}.job WHERE id = $1::uuid`,
    jobId,
  );
  return true;
}
