import { describe, it, expect } from "vitest";
import {
  runPostBuildAnalyze,
  getLastPostBuildAnalyze,
  POST_BUILD_ANALYZE_TABLES,
  ANALYZE_CONNECT_TIMEOUT_MS,
  ANALYZE_STATEMENT_TIMEOUT_MS,
  ANALYZE_OVERALL_BUDGET_MS,
  type MaintenanceClient,
} from "~/lib/jobs/analyze.server";

/*
 * Phase 14e E1 — the post-build ANALYZE maintenance connection is fully bounded
 * and can NEVER fail or hang the full-sync job. These inject a fake client (a
 * hanging connect, a failing query, a working one) so no real DB is needed, and
 * assert runPostBuildAnalyze always resolves within the budget and never throws.
 * Also covers E3 — the per-process last-outcome record.
 */

const okClient = (calls: string[]): MaintenanceClient => ({
  connect: async () => {},
  query: async (sql: string) => { calls.push(sql); return {}; },
  end: async () => {},
});

const hangingClient = (): MaintenanceClient => ({
  connect: () => new Promise<void>(() => {}), // never resolves
  query: async () => ({}),
  end: async () => {},
});

const failOnConnect = (): MaintenanceClient => ({
  connect: async () => { throw new Error("ECONNREFUSED boom"); },
  query: async () => ({}),
  end: async () => {},
});

describe("Phase 14e E1 — bounded, non-throwing maintenance ANALYZE", () => {
  it("bounds are within the spec ceilings (connect<=10s, stmt<=120s, overall<=150s)", () => {
    expect(ANALYZE_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(ANALYZE_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    expect(ANALYZE_OVERALL_BUDGET_MS).toBeLessThanOrEqual(150_000);
  });

  it("success: analyzes exactly the allowlist and records status ok", async () => {
    const calls: string[] = [];
    const r = await runPostBuildAnalyze({
      connectionString: "postgres://ignored",
      clientFactory: () => okClient(calls),
    });
    expect(r.status).toBe("ok");
    expect(r.analyzed).toEqual([...POST_BUILD_ANALYZE_TABLES]);
    // one ANALYZE per allowlisted table, and every statement is a quoted ANALYZE
    expect(calls.length).toBe(POST_BUILD_ANALYZE_TABLES.length);
    for (const c of calls) expect(c).toMatch(/^ANALYZE "/);
    expect(getLastPostBuildAnalyze()?.status).toBe("ok");
  });

  it("HANGING connection: returns status timeout within the budget and does NOT throw or hang", async () => {
    const t0 = Date.now();
    const r = await runPostBuildAnalyze({
      connectionString: "postgres://ignored",
      clientFactory: () => hangingClient(),
      overallBudgetMs: 150, // tiny budget for the test
    });
    const elapsed = Date.now() - t0;
    expect(r.status).toBe("timeout");
    expect(r.analyzed).toEqual([]);
    expect(elapsed).toBeLessThan(2_000); // bounded — nowhere near a real hang
    expect(getLastPostBuildAnalyze()?.status).toBe("timeout");
  });

  it("CONNECT FAILURE: returns status error, never throws", async () => {
    const r = await runPostBuildAnalyze({
      connectionString: "postgres://ignored",
      clientFactory: () => failOnConnect(),
    });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(getLastPostBuildAnalyze()?.status).toBe("error");
  });

  it("GUARD: a caller-supplied non-allowlisted table name is filtered out (never analyzed)", async () => {
    const calls: string[] = [];
    // Hostile input: ask for "shop" (not on the allowlist) alongside a real one.
    const r = await runPostBuildAnalyze({
      connectionString: "postgres://ignored",
      clientFactory: () => okClient(calls),
      tables: ["shop", "product", "pg_authid"] as unknown as string[],
    });
    // Only the allowlisted intersection is analyzed; injected names are dropped.
    expect(r.analyzed).toEqual(["product"]);
    expect(calls.join(" ")).not.toMatch(/shop|pg_authid/);
  });

  it("no MAINTENANCE_DATABASE_URL: no-op skip (never reaches the DB)", async () => {
    const saved = process.env.MAINTENANCE_DATABASE_URL;
    delete process.env.MAINTENANCE_DATABASE_URL;
    try {
      let built = false;
      const r = await runPostBuildAnalyze({
        clientFactory: () => { built = true; return okClient([]); },
      });
      expect(r.status).toBe("skipped:no-url");
      expect(built).toBe(false); // never even constructs a client
    } finally {
      if (saved !== undefined) process.env.MAINTENANCE_DATABASE_URL = saved;
    }
  });
});
