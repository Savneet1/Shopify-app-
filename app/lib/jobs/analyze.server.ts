import pg from "pg";
import { logger } from "~/lib/logger.server";

/**
 * Phase 14d X2(c) — synchronous post-build planner-statistics refresh.
 *
 * WHY: immediately after a bulk sync + index build, pg_class.reltuples for
 * product_search_doc is -1 (a plain bulk INSERT never refreshes it; only
 * VACUUM/ANALYZE/CREATE INDEX do, and the indexes pre-exist). With no row
 * estimate the planner mis-estimates the per-product delta lookup at ~1 row and
 * scans the whole shop via the shop-only index instead of the unique
 * (shop_id, index_version_id, product_id) index — a ~35x write-path regression
 * (measured in docs/PHASE14D.md). Migration 0020/0026 reloptions let autovacuum
 * repair this, but autovacuum is asynchronous (naptime, bounded workers) so it
 * cannot guarantee fresh stats *immediately* after a build. This refresh closes
 * that window deterministically.
 *
 * PRIVILEGE MODEL: ANALYZE requires table ownership; app_runtime is NOSUPERUSER
 * and NOT a table owner, and PostgreSQL 16 has no MAINTAIN privilege. Rather than
 * add a SECURITY DEFINER wrapper, this opens a short-lived OWNER connection
 * (DIRECT_DATABASE_URL = app_owner, the same role that runs migrations) used for
 * NOTHING but ANALYZE on a FIXED table allowlist. It touches no tenant rows,
 * takes no user input, and grants app_runtime no new capability. If
 * DIRECT_DATABASE_URL is not configured, this is a no-op and the system falls
 * back to the autovacuum reloptions (slower, but correct).
 *
 * The allowlist is a module constant — table names are never taken from input,
 * so the dynamic ANALYZE statements cannot be influenced by any caller.
 */
export const POST_BUILD_ANALYZE_TABLES = [
  "product_search_doc",
  "product",
  "variant",
  "search_vocabulary",
  "search_facet_value",
  "search_facet_summary",
  "search_suggest_term",
] as const;

export interface AnalyzeResult {
  analyzed: string[];
  skipped?: "no-direct-url" | "error";
  ms: number;
}

/**
 * Refresh planner statistics for the fixed build-output table allowlist via a
 * short-lived owner connection. Never throws — a stats refresh is best-effort
 * (autovacuum is the fallback), so a failure here must not fail the sync job.
 */
export async function runPostBuildAnalyze(opts?: {
  connectionString?: string;
  tables?: readonly string[];
}): Promise<AnalyzeResult> {
  const t0 = Date.now();
  const connectionString = opts?.connectionString ?? process.env.DIRECT_DATABASE_URL;
  if (!connectionString) {
    logger.warn(
      { fallback: "autovacuum" },
      "post-build ANALYZE skipped: DIRECT_DATABASE_URL (app_owner) not configured",
    );
    return { analyzed: [], skipped: "no-direct-url", ms: Date.now() - t0 };
  }
  // Only ever analyze names from the module allowlist — never caller input.
  const requested = opts?.tables ?? POST_BUILD_ANALYZE_TABLES;
  const tables = POST_BUILD_ANALYZE_TABLES.filter((t) => requested.includes(t));
  const client = new pg.Client({ connectionString });
  const analyzed: string[] = [];
  try {
    await client.connect();
    for (const t of tables) {
      // t is a compile-time constant from the allowlist; quote defensively anyway.
      await client.query(`ANALYZE "${t}"`);
      analyzed.push(t);
    }
    logger.info({ analyzed: analyzed.length, ms: Date.now() - t0 }, "post-build ANALYZE complete");
    return { analyzed, ms: Date.now() - t0 };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), analyzed: analyzed.length, fallback: "autovacuum" },
      "post-build ANALYZE failed (non-fatal)",
    );
    return { analyzed, skipped: "error", ms: Date.now() - t0 };
  } finally {
    await client.end().catch(() => {});
  }
}
