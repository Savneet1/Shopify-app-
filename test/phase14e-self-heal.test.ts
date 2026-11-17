import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import {
  detectStaleMaintenanceStats,
  checkStatsMaintenanceHealth,
} from "~/lib/jobs/stats-health.server";
import {
  runStatsSelfHeal,
  resetStatsSelfHealThrottle,
} from "~/lib/jobs/maintenance";
import type { AnalyzeResult } from "~/lib/jobs/analyze.server";

/*
 * Phase 14e E4 — self-healing stale-statistics check + E3 health signal. The
 * detection is unit-tested with injected stats rows (deterministic) and smoke-
 * tested against the real DB as app_runtime (proves pg_stat_user_tables is
 * readable without table privilege). runStatsSelfHeal is tested with injected
 * detect/analyze for throttle, heal-when-stale, skip-when-fresh and
 * skip-when-unconfigured — never throwing.
 */

// A fake Exec that returns canned pg_stat rows regardless of the query.
const fakeExec = (rows: unknown[]): Exec => ({
  rows: async <T>() => rows as T[],
  run: async () => 0,
});

const row = (relname: string, reltuples: number, n_live_tup: number, n_mod: number) => ({
  relname, reltuples, n_live_tup, n_mod_since_analyze: n_mod,
});

describe("Phase 14e E4 — stale-stats detection", () => {
  it("flags a populated, never-analyzed table (reltuples < 0, live > 0)", async () => {
    const stale = await detectStaleMaintenanceStats(
      fakeExec([row("product_search_doc", -1, 100_000, 0)]),
    );
    expect(stale).toEqual(["product_search_doc"]);
  });

  it("does NOT flag an empty table (live = 0) even when never analyzed", async () => {
    const stale = await detectStaleMaintenanceStats(
      fakeExec([row("product", -1, 0, 0)]),
    );
    expect(stale).toEqual([]);
  });

  it("does NOT flag a freshly-analyzed populated table", async () => {
    const stale = await detectStaleMaintenanceStats(
      fakeExec([row("variant", 50_000, 50_000, 10)]),
    );
    expect(stale).toEqual([]);
  });

  it("flags a table that has drifted > 20% since the last analyze", async () => {
    const stale = await detectStaleMaintenanceStats(
      fakeExec([row("search_vocabulary", 1000, 1000, 300)]), // 30% drift
    );
    expect(stale).toEqual(["search_vocabulary"]);
  });

  it("checkStatsMaintenanceHealth maps stale -> degraded and never throws", async () => {
    const degraded = await checkStatsMaintenanceHealth(fakeExec([row("product", -1, 5, 0)]));
    expect(degraded).toEqual({ degraded: true, staleCount: 1 });
    const healthy = await checkStatsMaintenanceHealth(fakeExec([row("product", 5, 5, 0)]));
    expect(healthy).toEqual({ degraded: false, staleCount: 0 });
    // a throwing exec fails open (banner must never break the admin page)
    const throwing: Exec = { rows: async () => { throw new Error("boom"); }, run: async () => 0 };
    expect(await checkStatsMaintenanceHealth(throwing)).toEqual({ degraded: false, staleCount: 0 });
  });
});

describe("Phase 14e E4 — real detection runs as app_runtime", () => {
  let db: TestDb;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  it("reads pg_stat_user_tables without table privilege and returns an array", async () => {
    // Empty build-output tables => nothing stale; the point is the query runs as
    // app_runtime (catalog-readable) and the column names/casts are correct.
    const stale = await detectStaleMaintenanceStats(db.rootExec);
    expect(Array.isArray(stale)).toBe(true);
  });
});

describe("Phase 14e E4 — runStatsSelfHeal", () => {
  beforeEach(() => resetStatsSelfHealThrottle());
  const rootExec = fakeExec([]);
  const okAnalyze = async (): Promise<AnalyzeResult> => ({ analyzed: ["product"], status: "ok", ms: 1 });

  it("runs the bounded ANALYZE when stats are stale and the connection is configured", async () => {
    let called = 0;
    const r = await runStatsSelfHeal(rootExec, {
      detect: async () => ["product_search_doc"],
      analyze: async () => { called++; return okAnalyze(); },
      maintenanceUrl: "postgres://maint",
    });
    expect(r.ran).toBe(true);
    expect(r.stale).toEqual(["product_search_doc"]);
    expect(called).toBe(1);
  });

  it("does NOT run when stats are fresh", async () => {
    let called = 0;
    const r = await runStatsSelfHeal(rootExec, {
      detect: async () => [],
      analyze: async () => { called++; return okAnalyze(); },
      maintenanceUrl: "postgres://maint",
    });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("fresh");
    expect(called).toBe(0);
  });

  it("does NOT run when stale but MAINTENANCE_DATABASE_URL is unconfigured", async () => {
    const saved = process.env.MAINTENANCE_DATABASE_URL;
    delete process.env.MAINTENANCE_DATABASE_URL; // force the unconfigured path
    try {
      let called = 0;
      const r = await runStatsSelfHeal(rootExec, {
        detect: async () => ["product"],
        analyze: async () => { called++; return okAnalyze(); },
        // maintenanceUrl omitted -> falls back to (now-unset) env
      });
      expect(r.ran).toBe(false);
      expect(r.reason).toBe("not-configured");
      expect(called).toBe(0);
    } finally {
      if (saved !== undefined) process.env.MAINTENANCE_DATABASE_URL = saved;
    }
  });

  it("is throttled to at most once per interval", async () => {
    let detects = 0;
    const detect = async () => { detects++; return ["product"] as string[]; };
    const base = 1_000_000;
    await runStatsSelfHeal(rootExec, { detect, analyze: okAnalyze, maintenanceUrl: "x", now: base, minIntervalMs: 60_000 });
    const second = await runStatsSelfHeal(rootExec, { detect, analyze: okAnalyze, maintenanceUrl: "x", now: base + 30_000, minIntervalMs: 60_000 });
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("throttled");
    expect(detects).toBe(1); // second call short-circuits before detecting
    // after the interval elapses it runs again
    const third = await runStatsSelfHeal(rootExec, { detect, analyze: okAnalyze, maintenanceUrl: "x", now: base + 61_000, minIntervalMs: 60_000 });
    expect(third.ran).toBe(true);
    expect(detects).toBe(2);
  });

  it("never throws even if detect rejects", async () => {
    const r = await runStatsSelfHeal(rootExec, {
      detect: async () => { throw new Error("detect boom"); },
      analyze: okAnalyze,
      maintenanceUrl: "x",
    });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("detect-error");
  });
});
