import pg from "pg";
import { logger } from "~/lib/logger.server";

/**
 * Phase 14d/14e — synchronous post-build planner-statistics refresh.
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
 * PRIVILEGE MODEL (Phase 14e): ANALYZE requires table ownership and PostgreSQL 16
 * has no MAINTAIN privilege. Phase 14d used the migration-OWNER credential
 * (DIRECT_DATABASE_URL = app_owner) for this, which put far too much authority in
 * the worker (app_owner owns the whole schema). Phase 14e runs it as a dedicated
 * LEAST-PRIVILEGE role `app_maintenance` (MAINTENANCE_DATABASE_URL) that OWNS ONLY
 * the seven tables in POST_BUILD_ANALYZE_TABLES (migration 0027) and nothing else:
 * it can ANALYZE them but cannot read or write shop, session, email_setting,
 * back_in_stock_subscription, analytics_event or any other table, and is
 * NOBYPASSRLS. The DIRECT_DATABASE_URL fallback has been REMOVED — if
 * MAINTENANCE_DATABASE_URL is unset this is a no-op and the system falls back to
 * the autovacuum reloptions (slower, but correct). See docs/PHASE14E.md.
 *
 * ISOLATION (Phase 14e E1): the maintenance connection is bounded on every axis —
 * connect timeout, per-statement timeout, and an overall budget via Promise.race —
 * so a hung or slow database can never fail the sync job or hold it open beyond
 * the budget. Best-effort by contract: it never throws.
 *
 * The allowlist is a module constant — table names are never taken from input, so
 * the dynamic ANALYZE statements cannot be influenced by any caller.
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

/** E1 bounds (all well under their spec ceilings). */
export const ANALYZE_CONNECT_TIMEOUT_MS = 10_000; // <= 10s
export const ANALYZE_STATEMENT_TIMEOUT_MS = 120_000; // <= 120s
export const ANALYZE_OVERALL_BUDGET_MS = 150_000; // <= 150s overall guard

export type AnalyzeStatus = "ok" | "skipped:no-url" | "error" | "timeout";

export interface AnalyzeResult {
  analyzed: string[];
  status: AnalyzeStatus;
  ms: number;
  error?: string;
}

/** A minimal client surface so tests can inject a hanging/failing connection. */
export interface MaintenanceClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface RunPostBuildAnalyzeOptions {
  connectionString?: string;
  tables?: readonly string[];
  /** Overall time budget for the whole operation (connect + analyze + close). */
  overallBudgetMs?: number;
  /** Injectable client factory (tests). Defaults to a bounded pg.Client. */
  clientFactory?: (connectionString: string) => MaintenanceClient;
}

// E3 — last post-build ANALYZE outcome for THIS process (observability). The web
// process cannot read this (separate process); the admin notice derives its own
// signal from pg_stat_user_tables. This is for worker logs/metrics.
let lastOutcome: (AnalyzeResult & { at: string }) | null = null;
export function getLastPostBuildAnalyze(): (AnalyzeResult & { at: string }) | null {
  return lastOutcome;
}

function defaultClientFactory(connectionString: string): MaintenanceClient {
  return new pg.Client({
    connectionString,
    application_name: "boostlike-maintenance",
    connectionTimeoutMillis: ANALYZE_CONNECT_TIMEOUT_MS,
    statement_timeout: ANALYZE_STATEMENT_TIMEOUT_MS,
    query_timeout: ANALYZE_STATEMENT_TIMEOUT_MS,
  }) as unknown as MaintenanceClient;
}

/**
 * Refresh planner statistics for the fixed build-output table allowlist via a
 * short-lived, fully-bounded app_maintenance connection. NEVER throws and NEVER
 * runs longer than overallBudgetMs — a stats refresh is best-effort (autovacuum
 * is the fallback), so a failure or hang here must not fail or stall the job.
 */
export async function runPostBuildAnalyze(
  opts?: RunPostBuildAnalyzeOptions,
): Promise<AnalyzeResult> {
  const t0 = Date.now();
  const record = (r: AnalyzeResult): AnalyzeResult => {
    lastOutcome = { ...r, at: new Date().toISOString() };
    return r;
  };

  const connectionString = opts?.connectionString ?? process.env.MAINTENANCE_DATABASE_URL;
  if (!connectionString) {
    // E3: ERROR level — a missing maintenance credential silently makes writes
    // ~35x slower after each full sync, so it must be loud.
    logger.error(
      { fallback: "autovacuum" },
      "post-build ANALYZE skipped: MAINTENANCE_DATABASE_URL (app_maintenance) not configured — product writes can be much slower after a full sync until autovacuum catches up",
    );
    return record({ analyzed: [], status: "skipped:no-url", ms: Date.now() - t0 });
  }

  // Only ever analyze names from the module allowlist — never caller input.
  const requested = opts?.tables ?? POST_BUILD_ANALYZE_TABLES;
  const tables = POST_BUILD_ANALYZE_TABLES.filter((t) => requested.includes(t));
  const budget = opts?.overallBudgetMs ?? ANALYZE_OVERALL_BUDGET_MS;
  const makeClient = opts?.clientFactory ?? defaultClientFactory;

  const analyzed: string[] = [];
  const client = makeClient(connectionString);

  // The whole unit of work (connect + analyze + close) runs under a single
  // Promise.race against the overall budget, so the function always resolves
  // within `budget` even if the client wedges mid-connect or mid-ANALYZE.
  const doWork = async (): Promise<AnalyzeResult> => {
    try {
      await client.connect();
      for (const t of tables) {
        // t is a compile-time constant from the allowlist; quote defensively.
        await client.query(`ANALYZE "${t}"`);
        analyzed.push(t);
      }
      logger.info({ analyzed: analyzed.length, ms: Date.now() - t0 }, "post-build ANALYZE complete");
      return { analyzed, status: "ok", ms: Date.now() - t0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err: msg, analyzed: analyzed.length, fallback: "autovacuum" },
        "post-build ANALYZE failed (non-fatal)",
      );
      return { analyzed, status: "error", ms: Date.now() - t0, error: msg };
    } finally {
      // Best-effort close; on the timeout path doWork may never reach here, which
      // is why the guard abandons the client separately below.
      await client.end().catch(() => {});
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budget);
  });

  try {
    const outcome = await Promise.race([doWork(), guard]);
    if (outcome === "timeout") {
      logger.error(
        { budgetMs: budget, analyzed: analyzed.length, fallback: "autovacuum" },
        "post-build ANALYZE exceeded its time budget — abandoned (non-fatal)",
      );
      // Abandon the (possibly wedged) client without awaiting, so we never exceed
      // the budget. A short-lived connection; the DB closes it on its own timeout.
      void client.end().catch(() => {});
      return record({ analyzed, status: "timeout", ms: Date.now() - t0 });
    }
    return record(outcome);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
