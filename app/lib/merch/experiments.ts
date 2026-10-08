import type { Exec } from "~/lib/db/executor";
import { assignVariant, type Variant } from "./assign";

/**
 * A/B experiments (Phase 8.5): CRUD + aggregate exposure/click counters. No
 * per-user rows, no PII, no logged queries, no significance testing. A variant
 * is a rule set (rules tagged 'A'/'B' in merch_rule) plus an optional bounded
 * ranking-weight override. Stopping an experiment (status != 'running') makes
 * its variant rules inert immediately, restoring the default rule set.
 */

export const MAX_EXPERIMENTS_PER_SHOP = 50;
export const WEIGHT_OVERRIDE_BOUND = 90; // matches the migration CHECK + ranking class gap

export type ExperimentStatus = "draft" | "running" | "stopped";

export interface ExperimentRow {
  id: string;
  name: string;
  status: ExperimentStatus;
  split_pct: number;
  weight_override_a: number | null;
  weight_override_b: number | null;
  created_at: string;
}

export interface RunningExperiment {
  id: string;
  split_pct: number;
  weight_override_a: number | null;
  weight_override_b: number | null;
}

function clampOverride(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(-WEIGHT_OVERRIDE_BOUND, Math.min(WEIGHT_OVERRIDE_BOUND, n));
}

export async function listExperiments(exec: Exec, shopId: string): Promise<ExperimentRow[]> {
  return exec.rows<ExperimentRow>(
    `SELECT id, name, status, split_pct, weight_override_a, weight_override_b, created_at
     FROM ab_experiment WHERE shop_id=$1::uuid ORDER BY created_at DESC`,
    [shopId],
  );
}

export async function listRunningExperiments(exec: Exec, shopId: string): Promise<RunningExperiment[]> {
  return exec.rows<RunningExperiment>(
    `SELECT id, split_pct, weight_override_a, weight_override_b
     FROM ab_experiment WHERE shop_id=$1::uuid AND status='running' ORDER BY created_at ASC`,
    [shopId],
  );
}

export async function createExperiment(
  exec: Exec, shopId: string,
  input: { name: string; splitPct?: number; weightOverrideA?: unknown; weightOverrideB?: unknown },
): Promise<ExperimentRow> {
  const name = String(input.name ?? "").trim();
  if (name.length === 0) throw new Error("experiment name is required");
  if (name.length > 120) throw new Error("experiment name too long (max 120)");
  const count = (await exec.rows<{ n: number }>(`SELECT count(*)::int AS n FROM ab_experiment WHERE shop_id=$1::uuid`, [shopId]))[0].n;
  if (count >= MAX_EXPERIMENTS_PER_SHOP) throw new Error(`experiment limit reached (${MAX_EXPERIMENTS_PER_SHOP})`);
  let split = Math.floor(Number(input.splitPct));
  if (!Number.isFinite(split)) split = 50;
  split = Math.max(0, Math.min(100, split));
  const rows = await exec.rows<ExperimentRow>(
    `INSERT INTO ab_experiment (shop_id, name, status, split_pct, weight_override_a, weight_override_b)
     VALUES ($1::uuid, $2, 'draft', $3::int, $4::int, $5::int)
     RETURNING id, name, status, split_pct, weight_override_a, weight_override_b, created_at`,
    [shopId, name, split, clampOverride(input.weightOverrideA), clampOverride(input.weightOverrideB)],
  );
  return rows[0];
}

export async function setExperimentStatus(exec: Exec, shopId: string, id: string, status: ExperimentStatus): Promise<number> {
  if (!["draft", "running", "stopped"].includes(status)) throw new Error("invalid status");
  return exec.run(`UPDATE ab_experiment SET status=$3 WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id, status]);
}

export async function updateExperiment(
  exec: Exec, shopId: string, id: string,
  fields: { name?: string; splitPct?: number; weightOverrideA?: unknown; weightOverrideB?: unknown },
): Promise<number> {
  const name = fields.name != null ? String(fields.name).trim() : null;
  if (name != null && (name.length === 0 || name.length > 120)) throw new Error("invalid name");
  let split: number | null = null;
  if (fields.splitPct != null) {
    split = Math.floor(Number(fields.splitPct));
    if (!Number.isFinite(split)) split = null; else split = Math.max(0, Math.min(100, split));
  }
  return exec.run(
    `UPDATE ab_experiment SET
       name = COALESCE($3, name),
       split_pct = COALESCE($4::int, split_pct),
       weight_override_a = $5::int,
       weight_override_b = $6::int
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, id, name, split, clampOverride(fields.weightOverrideA), clampOverride(fields.weightOverrideB)],
  );
}

export async function deleteExperiment(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM ab_experiment WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

/** Compute the visitor's variant for every running experiment (deterministic). */
export function assignmentsFor(
  shopId: string, running: RunningExperiment[], token: string | null | undefined,
): Map<string, Variant> {
  const out = new Map<string, Variant>();
  for (const e of running) out.set(e.id, assignVariant(shopId, e.id, token, e.split_pct));
  return out;
}

/**
 * Record ONE aggregate event (exposure or click) for a variant. Validates that
 * the experiment exists and is running, and that the variant is known; the
 * counter row is created on first use. No per-user data is written.
 */
export async function recordEvent(
  exec: Exec, shopId: string, experimentId: string, variant: string, type: "exposure" | "click",
): Promise<boolean> {
  if (!["control", "A", "B"].includes(variant)) return false;
  const running = await exec.rows<{ id: string }>(
    `SELECT id FROM ab_experiment WHERE shop_id=$1::uuid AND id=$2::uuid AND status='running'`,
    [shopId, experimentId],
  );
  if (running.length === 0) return false;
  const col = type === "click" ? "clicks" : "exposures";
  await exec.run(
    `INSERT INTO ab_exposure (shop_id, experiment_id, variant, ${col}, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 1, now())
     ON CONFLICT (shop_id, experiment_id, variant)
     DO UPDATE SET ${col} = ab_exposure.${col} + 1, updated_at = now()`,
    [shopId, experimentId, variant],
  );
  return true;
}

export interface ExposureReportRow {
  experiment_id: string;
  name: string;
  status: ExperimentStatus;
  variant: string;
  exposures: number;
  clicks: number;
}

export async function exposureReport(exec: Exec, shopId: string): Promise<ExposureReportRow[]> {
  return exec.rows<ExposureReportRow>(
    `SELECT e.id AS experiment_id, e.name, e.status,
            x.variant, COALESCE(x.exposures,0)::int AS exposures, COALESCE(x.clicks,0)::int AS clicks
     FROM ab_experiment e
     LEFT JOIN ab_exposure x ON x.experiment_id = e.id AND x.shop_id = e.shop_id
     WHERE e.shop_id=$1::uuid
     ORDER BY e.created_at DESC, x.variant ASC`,
    [shopId],
  );
}
