/**
 * Phase 14.1 — benchmark harness. Loads a synthetic catalog through the REAL
 * sync→index build path, then times the public query paths AS app_runtime with
 * RLS ON (never as owner). Reports p50/p95/p99, SQL statements per request, and
 * EXPLAIN (ANALYZE, BUFFERS) for the heaviest statements. NOT part of `npm test`.
 */
import pg from "pg";
import type { Exec } from "~/lib/db/executor";
import { runFullSync, applyProductUpsert } from "~/lib/sync/orchestrator";
import { rebuildVocabulary } from "~/lib/search/vocabulary";
import { getActiveVersion } from "~/lib/index/engine";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { predictiveWithExec } from "~/lib/search/predictive";
import { catalogSuggestionsWithExec } from "~/lib/search/suggest";
import { getRecommendations } from "~/lib/recommend/engine";
import { saveCombinedMode } from "~/lib/search/combined";
import { generateCatalog, type GenResult } from "./gen";
import { summarize, round2, type Summary } from "./percentiles";

export interface CaseResult {
  name: string;
  concurrency: number;
  wall: Summary;        // ms per request
  stmts: Summary;       // SQL statements per request
}
export interface StmtProfile { sql: string; maxMs: number; count: number; sample: unknown[]; }

interface Pools { runtime: pg.Pool; owner: pg.Pool; }

function pools(maxRuntime: number): Pools {
  const runtimeUrl = need("TEST_DATABASE_URL");
  const ownerUrl = need("TEST_DIRECT_DATABASE_URL");
  return {
    runtime: new pg.Pool({ connectionString: runtimeUrl, max: maxRuntime }),
    owner: new pg.Pool({ connectionString: ownerUrl, max: 2 }),
  };
}
function need(n: string): string { const v = process.env[n]; if (!v) throw new Error(`Missing env ${n}`); return v; }

/** A per-call recording Exec over one tenant transaction. */
function recordingExec(client: pg.PoolClient, rec?: { sql: string; ms: number; params: unknown[] }[]): { exec: Exec; stmts: () => number } {
  let n = 0;
  const run = async (fn: () => Promise<pg.QueryResult>, sql: string, params: unknown[]) => {
    n++;
    const t = performance.now();
    const res = await fn();
    if (rec) rec.push({ sql, ms: performance.now() - t, params });
    return res;
  };
  const exec: Exec = {
    rows: async <T>(sql: string, params: unknown[] = []) => (await run(() => client.query(sql, params as unknown[]), sql, params)).rows as T[],
    run: async (sql: string, params: unknown[] = []) => (await run(() => client.query(sql, params as unknown[]), sql, params)).rowCount ?? 0,
  };
  return { exec, stmts: () => n };
}

export class Bench {
  private p: Pools;
  shopId = "";
  gen!: GenResult;
  readonly profile: { sql: string; ms: number; params: unknown[] }[] = [];
  constructor(maxRuntime = 12) { this.p = pools(maxRuntime); }

  private async withShop<T>(fn: (exec: Exec, stmts: () => number, rec?: { sql: string; ms: number; params: unknown[] }[]) => Promise<T>, record = false): Promise<T> {
    const client = await this.p.runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.shop_id', $1, true)", [this.shopId]);
      const { exec, stmts } = recordingExec(client, record ? this.profile : undefined);
      const r = await fn(exec, stmts, record ? this.profile : undefined);
      await client.query("COMMIT");
      return r;
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  }

  async setup(domain: string): Promise<void> {
    await this.p.owner.query("TRUNCATE shop CASCADE");
    const { rows } = await this.p.runtime.query<{ id: string }>("SELECT app_resolve_shop($1) AS id", [domain]);
    this.shopId = rows[0].id;
  }

  /** Load a synthetic catalog through the real full-sync build path. Returns
   * build wall-ms, docCount, and peak RSS delta (MB). */
  async load(size: number, seed = 1337, opts?: { analyze?: boolean }): Promise<{ buildMs: number; docCount: number; rssDeltaMb: number; gen: GenResult }> {
    this.gen = generateCatalog({ size, seed });
    const runner = <T,>(_sid: string, fn: (e: Exec) => Promise<T>) => this.withShop((e) => fn(e));
    const rss0 = process.memoryUsage().rss;
    const t = performance.now();
    const res = await runFullSync(runner as never, this.shopId, {
      productsJsonl: this.gen.productsJsonl,
      collectionsJsonl: this.gen.collectionsJsonl,
      shopifyObjectCount: null, snapshotStartedAt: null, jobId: null,
    } as never);
    const buildMs = performance.now() - t;
    const rssDeltaMb = Math.round((process.memoryUsage().rss - rss0) / 1e6);
    // Phase 14d X1: by default we DO NOT ANALYZE here, so the first measured pass
    // reflects the real post-bulk-load STALE-STATISTICS state that production
    // hits (app_runtime cannot ANALYZE; PG16 has no MAINTAIN; autovacuum has not
    // yet reached product_search_doc). Pass { analyze: true } for the steady-state
    // (fresh-stats) pass. `analyzeBaseTables()` performs the transition.
    if (opts?.analyze) await this.analyzeBaseTables();
    return { buildMs, docCount: (res as { docCount?: number }).docCount ?? 0, rssDeltaMb, gen: this.gen };
  }

  /** Owner-side ANALYZE of the hot tables — the steady-state (fresh-stats) point.
   * Production reaches this via autovacuum (migration 0020/0026 reloptions) or
   * the Phase 14d post-build maintenance ANALYZE; the harness calls it directly
   * to measure the fresh-stats upper bound next to the stale-stats worst case. */
  async analyzeBaseTables(): Promise<void> {
    for (const tbl of [
      "product_search_doc", "product", "variant",
      "search_vocabulary", "search_facet_value", "search_facet_summary", "search_suggest_term",
    ]) await this.p.owner.query(`ANALYZE ${tbl}`);
  }

  /** Run one query case: warm-up, then N iterations at the given concurrency. */
  async runCase(name: string, N: number, concurrency: number, op: (exec: Exec) => Promise<unknown>): Promise<CaseResult> {
    // warm-up
    for (let i = 0; i < Math.min(10, N); i++) await this.withShop(async (e) => op(e));
    const wall: number[] = []; const stmts: number[] = [];
    let launched = 0;
    const worker = async () => {
      while (launched < N) {
        launched++;
        const t = performance.now();
        const s = await this.withShop(async (e, stmtCount) => { await op(e); return stmtCount(); });
        wall.push(performance.now() - t); stmts.push(s);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { name, concurrency, wall: summarize(wall), stmts: summarize(stmts) };
  }

  /** Capture the heaviest distinct statements seen during a recorded profiling
   * pass, then EXPLAIN (ANALYZE, BUFFERS) the top `k`. */
  async explainTop(k: number): Promise<{ profile: StmtProfile[]; explains: { sql: string; plan: string }[] }> {
    const byKey = new Map<string, StmtProfile>();
    for (const r of this.profile) {
      const key = normalizeSql(r.sql);
      const cur = byKey.get(key);
      if (!cur) byKey.set(key, { sql: r.sql, maxMs: r.ms, count: 1, sample: r.params });
      else { cur.count++; if (r.ms > cur.maxMs) { cur.maxMs = r.ms; cur.sample = r.params; } }
    }
    const top = [...byKey.values()].sort((a, b) => b.maxMs - a.maxMs).slice(0, k);
    const explains: { sql: string; plan: string }[] = [];
    for (const t of top) {
      if (!/^\s*(select|with)/i.test(t.sql)) continue; // only read queries
      try {
        const plan = await this.withShop(async (e) => {
          const rows = await e.rows<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${t.sql}`, t.sample as unknown[]);
          return rows.map((r) => r["QUERY PLAN"]).join("\n");
        });
        explains.push({ sql: t.sql, plan });
      } catch (e) { explains.push({ sql: t.sql, plan: `EXPLAIN failed: ${(e as Error).message}` }); }
    }
    return { profile: top, explains };
  }

  clearProfile(): void { this.profile.length = 0; }

  /** Single-threaded recorded pass over every case (fills `this.profile`). */
  async profilePass(reps = 15): Promise<void> {
    const cases = this.cases(true);
    for (let i = 0; i < reps; i++) {
      for (const c of cases) await this.withShop(async (e) => c.op(e), true);
    }
  }

  // ---- query cases wired to the real public code paths ----
  async setCombinedMode(mode: "show_all" | "hide_children" | "hide_parents"): Promise<void> {
    await this.withShop((e) => saveCombinedMode(e, this.shopId, mode));
  }

  cases(record: boolean): { name: string; op: (e: Exec) => Promise<unknown> }[] {
    const s = this.gen.samples;
    const term = () => s.terms[Math.floor(Math.random() * s.terms.length)] || "shoe";
    const typo = () => s.typos[Math.floor(Math.random() * s.typos.length)] || "shoee";
    const vendor = () => s.vendors[Math.floor(Math.random() * s.vendors.length)];
    const type = () => s.types[Math.floor(Math.random() * s.types.length)];
    const seed = () => s.handles[Math.floor(Math.random() * s.handles.length)];
    const _ = record; // profiling uses the same ops
    return [
      { name: "predictive", op: (e) => predictiveWithExec(e, this.shopId, { q: term() }) },
      { name: "suggestions", op: (e) => catalogSuggestionsWithExec(e, this.shopId, (term() || "sho").slice(0, 4)) },
      { name: "search_no_filter", op: (e) => storefrontSearchWithExec(e, this.shopId, { q: term(), nl: false, limit: 24, offset: 0 }) },
      { name: "search_1_filter", op: (e) => storefrontSearchWithExec(e, this.shopId, { q: term(), nl: false, limit: 24, offset: 0, filters: { vendor: [vendor()] } }) },
      { name: "search_3_filters", op: (e) => storefrontSearchWithExec(e, this.shopId, { q: term(), nl: false, limit: 24, offset: 0, filters: { vendor: [vendor()], productType: [type()], available: true } }) },
      { name: "typo", op: (e) => storefrontSearchWithExec(e, this.shopId, { q: typo(), nl: false, limit: 24, offset: 0 }) },
      { name: "nl_parsed", op: (e) => storefrontSearchWithExec(e, this.shopId, { q: `${type()} under 100`, nl: true, limit: 24, offset: 0 }) },
      { name: "browse_facets", op: (e) => storefrontSearchWithExec(e, this.shopId, { q: "", nl: false, limit: 24, offset: 0 }) },
      { name: "rec_similar", op: (e) => getRecommendations(e, this.shopId, { type: "similar", seed: seed(), limit: 8 }) },
      { name: "rec_related", op: (e) => getRecommendations(e, this.shopId, { type: "related", seed: seed(), limit: 8 }) },
      { name: "rec_trending", op: (e) => getRecommendations(e, this.shopId, { type: "trending", limit: 8 }) },
    ];
  }

  // ---- Phase 14c W3: WRITE-path cases (real webhook-apply path) ----
  /** A sample of existing product GIDs to update. */
  async sampleGids(k: number): Promise<string[]> {
    const rows = await this.withShop((e) => e.rows<{ g: string }>(
      `SELECT shopify_product_gid g FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL ORDER BY random() LIMIT $2`,
      [this.shopId, k]));
    return rows.map((r) => r.g);
  }

  /** Build a realistic single-product update (changes price/availability/tags/
   * vendor/type/title) for an existing gid. */
  private buildUpdate(gid: string, i: number): unknown {
    const s = this.gen.samples;
    const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
    const n = gid.split("/").pop();
    return {
      product: {
        shopifyProductGid: gid, title: `${pick(s.terms)} ${n} r${i}`, handle: `h${n}`,
        vendor: pick(s.vendors), productType: pick(s.types), status: "ACTIVE",
        tags: [pick(s.terms), pick(s.terms)], onlineStoreUrl: `https://x.test/${n}`,
        featuredImageUrl: "https://img/x.jpg", featuredImageAlt: "x",
        metafields: { "custom.material": pick(["Leather", "Rubber", "Canvas"]) },
        combinedRole: null, combinedParentGid: null,
      },
      variants: [{ shopifyVariantGid: `${gid}/v1`, sku: `S${n}`, price: String(5 + Math.floor(Math.random() * 95)), availableForSale: Math.random() > 0.25, position: 1 }],
      collectionGids: [], variantsComplete: true, collectionsComplete: true,
    };
  }

  /** Apply `count` single-product updates through applyProductUpsert (one tenant
   * transaction each — the real webhook path). Reports per-update wall + stmts
   * and the total drain time. */
  async runWriteCase(name: string, count: number): Promise<CaseResult & { totalMs: number }> {
    const gids = await this.sampleGids(Math.min(count, 2000));
    if (gids.length === 0) throw new Error("no products to update");
    // Each update is its own tenant transaction (the real webhook path): a
    // ShopRunner bound to that transaction's exec.
    const apply = (gid: string, i: number) => this.withShop(async (e, stmtCount) => {
      const runner1 = <T,>(_sid: string, fn: (ee: Exec) => Promise<T>) => fn(e);
      await applyProductUpsert(runner1 as never, this.shopId, this.buildUpdate(gid, i) as never);
      return stmtCount();
    });
    // warm-up
    for (let i = 0; i < Math.min(5, count); i++) await apply(gids[i % gids.length], -1 - i);
    const wall: number[] = []; const stmts: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      const t = performance.now();
      const s = await apply(gids[i % gids.length], i);
      wall.push(performance.now() - t); stmts.push(s);
    }
    const totalMs = performance.now() - t0;
    return { name, concurrency: 1, wall: summarize(wall), stmts: summarize(stmts), totalMs };
  }

  /** The 14b per-update structure-maintenance cost: one full rebuildVocabulary
   * (which also rebuilds the facet/suggest/summary precompute) over the whole
   * visible catalog. This is what every product write paid on 17ec787; 14c's
   * delta replaces it. Measured in the same node for an honest before/after. */
  async baselineRebuild(count: number): Promise<Summary> {
    const verId = await this.withShop(async (e) => (await getActiveVersion(e, this.shopId))!.id);
    const t: number[] = [];
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      await this.withShop((e) => rebuildVocabulary(e, this.shopId, verId));
      t.push(performance.now() - t0);
    }
    return summarize(t);
  }

  // ---- Phase 14d: stale-statistics measurement support ----

  /** Pin the stale-statistics window: toggle autovacuum on the build-output
   * tables (owner), so a stale pass is not silently "fixed" by an autovacuum
   * analyze firing mid-measurement. Re-enabled for the fresh pass. */
  async setAutovacuum(enabled: boolean): Promise<void> {
    const v = enabled ? "true" : "false";
    for (const tbl of [
      "product_search_doc", "product", "variant",
      "search_vocabulary", "search_facet_value", "search_facet_summary", "search_suggest_term",
    ]) await this.p.owner.query(`ALTER TABLE ${tbl} SET (autovacuum_enabled = ${v})`);
  }

  /** pg_class.reltuples for product_search_doc (−1 == never analyzed). */
  async reltuples(): Promise<number> {
    const { rows } = await this.p.owner.query<{ rt: string }>(
      "SELECT reltuples::bigint AS rt FROM pg_class WHERE relname = 'product_search_doc'");
    return Number(rows[0]?.rt ?? 0);
  }

  /** Measure a single named read case at concurrency 1. */
  async runNamedCase(name: string, N: number): Promise<CaseResult> {
    const c = this.cases(false).find((x) => x.name === name);
    if (!c) throw new Error(`no case ${name}`);
    return this.runCase(name, N, 1, c.op);
  }

  /** Phase 14d X1: capture EXPLAIN (ANALYZE, BUFFERS) for the delta write-path
   * statements that read product_search_doc, in the CURRENT statistics state.
   * Records one real applyProductUpsert to get the exact statements+params, then
   * re-plans each inside a rolled-back transaction (so the capture mutates
   * nothing). Returns compact plan facts so the report can show which statements
   * scan the whole shop when stats are stale. */
  async explainDeltaWritePath(): Promise<{ label: string; index: string; seqScan: boolean; estRows: number; actualRows: number; rowsRemoved: number; buffers: number; ms: number }[]> {
    const gid = (await this.sampleGids(1))[0];
    const rec: { sql: string; ms: number; params: unknown[] }[] = [];
    await this.withShop(async (e, _s, r) => {
      const runner1 = <T,>(_sid: string, fn: (ee: Exec) => Promise<T>) => fn(e);
      await applyProductUpsert(runner1 as never, this.shopId, this.buildUpdate(gid, 0) as never);
      if (r) rec.push(...r.splice(0));
    }, true);
    // statements that touch product_search_doc and are worth planning
    const want = rec.filter((s) => /product_search_doc/.test(s.sql) && /^\s*(insert|update|with|select)/i.test(s.sql));
    const seen = new Set<string>();
    const out: { label: string; index: string; seqScan: boolean; estRows: number; actualRows: number; rowsRemoved: number; buffers: number; ms: number }[] = [];
    for (const s of want) {
      const key = normalizeSql(s.sql);
      if (seen.has(key)) continue; seen.add(key);
      const label = labelForDelta(s.sql);
      const plan = await this.explainRolledBack(s.sql, s.params);
      if (!plan) continue;
      const psdLine = plan.split("\n").find((l) => /on product_search_doc/.test(l)) ?? "";
      const index = (psdLine.match(/using (\w+)/) || [])[1] ?? (/Seq Scan on product_search_doc/.test(psdLine) ? "(seqscan)" : "(none)");
      out.push({
        label,
        index,
        seqScan: /Seq Scan on product_search_doc/.test(plan),
        estRows: Number((psdLine.match(/rows=(\d+)/) || [])[1] ?? 0),
        actualRows: Number((psdLine.match(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/) || [])[1] ?? 0),
        rowsRemoved: Math.max(...(plan.match(/Rows Removed by Filter: (\d+)/g) || []).map((m) => Number(m.split(": ")[1])), 0),
        buffers: Number((plan.match(/Buffers: shared hit=(\d+)/) || [])[1] ?? 0),
        ms: Number((plan.match(/Execution Time: ([\d.]+)/) || [])[1] ?? 0),
      });
    }
    return out;
  }

  /** EXPLAIN (ANALYZE, BUFFERS) a statement inside a rolled-back tenant txn so
   * executing a mutating statement for its plan leaves no trace. */
  private async explainRolledBack(sql: string, params: unknown[]): Promise<string | null> {
    const client = await this.p.runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.shop_id', $1, true)", [this.shopId]);
      const r = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params as unknown[]);
      await client.query("ROLLBACK");
      return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
    } catch { try { await client.query("ROLLBACK"); } catch { /* ignore */ } return null; } finally { client.release(); }
  }

  async close(): Promise<void> { await this.p.runtime.end(); await this.p.owner.end(); }
}

function labelForDelta(sql: string): string {
  if (/INTO search_vocabulary/i.test(sql)) return "vocab delta (insert/subtract)";
  if (/INTO search_facet_value/i.test(sql)) return "facet_value delta";
  if (/INTO search_suggest_term/i.test(sql)) return "suggest delta";
  if (/UPDATE search_facet_summary/i.test(sql)) return "facet_summary delta";
  if (/INTO product_search_doc/i.test(sql) || /UPDATE product_search_doc/i.test(sql)) return "doc upsert";
  return "psd read";
}

/** Collapse a SQL string to a grouping key (ignore whitespace + numeric literals). */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\$\d+/g, "$?").trim().slice(0, 400);
}

export { round2 };
export type { Summary };
