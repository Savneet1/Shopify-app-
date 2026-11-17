import type { Exec } from "~/lib/db/executor";
import { POST_BUILD_ANALYZE_TABLES } from "./analyze.server";

/**
 * Phase 14e — planner-statistics freshness detection for the seven build-output
 * tables. Read-only and runs as app_runtime: pg_stat_user_tables and pg_class are
 * catalog-readable without any table privilege, so both the worker tick (E4) and
 * the admin overview loader (E3) can call this from their own process. It exposes
 * NO connection strings or role names.
 *
 * A table is STALE only when it HAS LIVE ROWS and either:
 *   (a) has never been analyzed since those rows arrived — reltuples < 0, the
 *       sentinel a plain bulk INSERT leaves (the Phase 14d condition); or
 *   (b) has drifted more than `staleRatio` of its live rows since the last
 *       analyze (n_mod_since_analyze > ratio * n_live_tup).
 * An EMPTY table (n_live_tup = 0) is never stale — a fresh install whose build-
 * output tables are empty is not degraded — and this makes self-heal converge
 * (ANALYZE sets reltuples to 0, after which the table is no longer flagged).
 * n_live_tup comes from the stats collector and tracks inserts independently of
 * ANALYZE, so a never-analyzed bulk-loaded table still reports its row count.
 */
export interface StaleStatsRow {
  relname: string;
  reltuples: number;
  n_live_tup: number;
  n_mod_since_analyze: number;
}

export async function detectStaleMaintenanceStats(
  rootExec: Exec,
  opts: { staleRatio?: number; tables?: readonly string[] } = {},
): Promise<string[]> {
  const ratio = opts.staleRatio ?? 0.2;
  const tables = (opts.tables ?? POST_BUILD_ANALYZE_TABLES) as readonly string[];
  const rows = await rootExec.rows<StaleStatsRow>(
    `SELECT s.relname,
            c.reltuples::float8           AS reltuples,
            s.n_live_tup::float8          AS n_live_tup,
            s.n_mod_since_analyze::float8  AS n_mod_since_analyze
       FROM pg_stat_user_tables s
       JOIN pg_class c ON c.oid = s.relid
      WHERE s.schemaname = 'public' AND s.relname = ANY($1::text[])`,
    [tables as unknown as string[]],
  );
  const stale: string[] = [];
  for (const r of rows) {
    const reltuples = Number(r.reltuples);
    const live = Number(r.n_live_tup);
    const modded = Number(r.n_mod_since_analyze);
    if (live <= 0) continue; // empty table: never a performance problem
    if (reltuples < 0) stale.push(r.relname); // has rows but never analyzed
    else if (modded > ratio * live) stale.push(r.relname); // drifted since analyze
  }
  return stale;
}

export interface StatsMaintenanceHealth {
  /** True when planner stats on the build-output tables are stale enough that
   *  product writes may be much slower after a full sync. */
  degraded: boolean;
  /** How many of the seven tables are stale (for a terse admin hint; no internals). */
  staleCount: number;
}

/**
 * E3 — the signal the admin overview renders. Derived purely from observed
 * staleness so it is correct across processes (the web process need not share the
 * worker's MAINTENANCE_DATABASE_URL): if the worker's ANALYZE is unconfigured or
 * failing, stats stay stale and this reports degraded; when healthy, stats are
 * fresh and it reports OK. Never throws — a detection error reports NOT degraded
 * (fail-open for a cosmetic banner) so the admin page always renders.
 */
export async function checkStatsMaintenanceHealth(
  rootExec: Exec,
  opts: { staleRatio?: number } = {},
): Promise<StatsMaintenanceHealth> {
  try {
    const stale = await detectStaleMaintenanceStats(rootExec, opts);
    return { degraded: stale.length > 0, staleCount: stale.length };
  } catch {
    return { degraded: false, staleCount: 0 };
  }
}
