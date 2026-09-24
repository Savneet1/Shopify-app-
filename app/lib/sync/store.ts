import type { Exec } from "~/lib/db/executor";

/** sync_run / sync_failure / job_audit persistence (RLS-bound via caller). */

/** Recover stale 'running' sync_run rows (crashed worker) so a new sync can start. */
export async function recoverStaleRuns(
  exec: Exec,
  shopId: string,
  olderThanMinutes = 60,
): Promise<number> {
  return exec.run(
    `UPDATE sync_run SET status='failed', error='stale: recovered', finished_at=now(), updated_at=now()
     WHERE shop_id=$1::uuid AND status='running'
       AND started_at < now() - ($2 || ' minutes')::interval`,
    [shopId, String(olderThanMinutes)],
  );
}

/**
 * Start a sync run. The partial unique index sync_run(shop_id) WHERE
 * status='running' guarantees at most one running sync per shop, so a concurrent
 * full sync throws a unique violation here (caller treats it as "already
 * running" and skips).
 */
export async function startSyncRun(
  exec: Exec,
  shopId: string,
  type: "bulk_full" | "incremental",
  jobId: string | null = null,
): Promise<string> {
  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO sync_run (shop_id, type, status, job_id, started_at)
     VALUES ($1::uuid,$2,'running',$3, now()) RETURNING id`,
    [shopId, type, jobId],
  );
  return rows[0].id;
}

export function isAlreadyRunning(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /sync_run_one_running_per_shop|duplicate key|unique constraint/i.test(msg);
}

export async function updateSyncRunStats(
  exec: Exec,
  shopId: string,
  id: string,
  data: { productCount?: number | null; stats?: unknown; warning?: string | null },
): Promise<void> {
  await exec.run(
    `UPDATE sync_run SET product_count=$3::int, stats=$4::jsonb, warning=$5, updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, id, data.productCount ?? null, JSON.stringify(data.stats ?? null), data.warning ?? null],
  );
}

export async function completeSyncRun(
  exec: Exec,
  shopId: string,
  id: string,
  data: { objectCount?: number | null; indexVersionId?: string | null },
): Promise<void> {
  await exec.run(
    `UPDATE sync_run SET status='completed', object_count=$3::int, index_version_id=$4::uuid,
        finished_at=now(), updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, id, data.objectCount ?? null, data.indexVersionId ?? null],
  );
}

export async function failSyncRun(
  exec: Exec,
  shopId: string,
  id: string,
  error: string,
): Promise<void> {
  await exec.run(
    `UPDATE sync_run SET status='failed', error=$3, finished_at=now(), updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, id, error],
  );
}

export async function recordSyncFailure(
  exec: Exec,
  shopId: string,
  syncRunId: string | null,
  stage: string,
  error: string,
  payload: unknown = null,
): Promise<void> {
  await exec.run(
    `INSERT INTO sync_failure (shop_id, sync_run_id, stage, error, payload)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb)`,
    [shopId, syncRunId, stage, error, JSON.stringify(payload ?? null)],
  );
}

export async function claimJob(
  exec: Exec,
  shopId: string,
  queue: string,
  dedupeKey: string,
  jobId: string | null = null,
): Promise<boolean> {
  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO job_audit (shop_id, queue, dedupe_key, job_id, status, attempt)
     VALUES ($1::uuid,$2,$3,$4,'started',1)
     ON CONFLICT (shop_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [shopId, queue, dedupeKey, jobId],
  );
  return rows.length > 0;
}

export async function beginJobAttempt(
  exec: Exec,
  shopId: string,
  queue: string,
  dedupeKey: string,
  jobId: string | null = null,
): Promise<{ proceed: boolean; attempt: number }> {
  const existing = await exec.rows<{ status: string; attempt: number }>(
    `SELECT status, attempt FROM job_audit WHERE shop_id=$1::uuid AND dedupe_key=$2`,
    [shopId, dedupeKey],
  );
  if (existing[0]?.status === "completed") {
    return { proceed: false, attempt: existing[0].attempt };
  }
  const rows = await exec.rows<{ attempt: number }>(
    `INSERT INTO job_audit (shop_id, queue, dedupe_key, job_id, status, attempt)
     VALUES ($1::uuid,$2,$3,$4,'started',1)
     ON CONFLICT (shop_id, dedupe_key) DO UPDATE
       SET attempt = job_audit.attempt + 1, status='started',
           job_id = COALESCE(EXCLUDED.job_id, job_audit.job_id), updated_at=now()
     RETURNING attempt`,
    [shopId, queue, dedupeKey, jobId],
  );
  return { proceed: true, attempt: rows[0].attempt };
}

export async function markJob(
  exec: Exec,
  shopId: string,
  dedupeKey: string,
  status: "completed" | "failed",
  error: string | null = null,
): Promise<void> {
  await exec.run(
    `UPDATE job_audit SET status=$3, error=$4, updated_at=now()
     WHERE shop_id=$1::uuid AND dedupe_key=$2`,
    [shopId, dedupeKey, status, error],
  );
}
