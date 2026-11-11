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
  async load(size: number, seed = 1337): Promise<{ buildMs: number; docCount: number; rssDeltaMb: number; gen: GenResult }> {
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
    // Phase 14.2: refresh planner statistics after the bulk build (owner-side;
    // app_runtime cannot ANALYZE and we add no SECURITY DEFINER). In production
    // migration 0020's autovacuum settings do this promptly; here we ANALYZE
    // explicitly so the reported plans are representative of steady state.
    await this.p.owner.query("ANALYZE product_search_doc");
    await this.p.owner.query("ANALYZE product");
    await this.p.owner.query("ANALYZE variant");
    return { buildMs, docCount: (res as { docCount?: number }).docCount ?? 0, rssDeltaMb, gen: this.gen };
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

  async close(): Promise<void> { await this.p.runtime.end(); await this.p.owner.end(); }
}

/** Collapse a SQL string to a grouping key (ignore whitespace + numeric literals). */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\$\d+/g, "$?").trim().slice(0, 400);
}

export { round2 };
export type { Summary };
