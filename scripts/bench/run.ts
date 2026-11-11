/**
 * Phase 14.1 — benchmark runner. `npm run bench -- --size=10000 [--n=200] [--seed=1337] [--quick]`
 * Loads a synthetic catalog via the real build path and measures the public
 * query paths as app_runtime (RLS ON). Writes JSON + docs/PHASE14_BENCH.md and
 * prints PASS/FAIL vs the F14 targets. NOT part of `npm test`.
 */
import os from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config as dotenv } from "dotenv";
import pg from "pg";
import { Bench, type CaseResult } from "./harness";

dotenv();
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

function arg(name: string, def?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  if (process.argv.includes(`--${name}`)) return "true";
  return def;
}

interface TargetCheck { target: string; measured: number; limit: number; unit: string; pass: boolean; }

async function pgInfo(): Promise<Record<string, string>> {
  const c = new pg.Client({ connectionString: process.env.TEST_DIRECT_DATABASE_URL });
  await c.connect();
  const out: Record<string, string> = {};
  out.version = (await c.query("SHOW server_version")).rows[0].server_version;
  for (const s of ["shared_buffers", "work_mem", "effective_cache_size", "max_connections"]) {
    try { out[s] = (await c.query(`SHOW ${s}`)).rows[0][s]; } catch { /* ignore */ }
  }
  await c.end();
  return out;
}

async function main() {
  const size = parseInt(arg("size", "10000")!, 10);
  const seed = parseInt(arg("seed", "1337")!, 10);
  const quick = arg("quick") === "true";
  const N = parseInt(arg("n", quick ? "50" : "200")!, 10);
  const concurrencies = quick ? [1] : [1, 8];

  const bench = new Bench(16);
  const started = new Date();
  console.log(`[bench] size=${size} seed=${seed} N=${N} concurrency=${concurrencies.join(",")}`);

  await bench.setup(`bench-${size}.myshopify.com`);
  const load = await bench.load(size, seed);
  console.log(`[bench] loaded ${load.docCount} docs in ${Math.round(load.buildMs)}ms (rssΔ ${load.rssDeltaMb}MB); stats=${JSON.stringify(load.gen.stats)}`);

  // profiling pass (record SQL) → EXPLAIN top statements
  bench.clearProfile();
  await bench.profilePass(15);
  const { profile: topStmts, explains } = await bench.explainTop(10);

  // measurement pass
  const results: CaseResult[] = [];
  for (const conc of concurrencies) {
    for (const c of bench.cases(false)) {
      results.push(await bench.runCase(c.name, N, conc, c.op));
    }
  }
  // combined-mode-on search (merch/combined path)
  await bench.setCombinedMode("hide_children");
  const combined = await bench.runCase("search_combined_hide", N, concurrencies[0], bench.cases(false)[1].op);
  await bench.setCombinedMode("show_all");
  results.push(combined);

  // Phase 14c W3: WRITE-path cases through the real applyProductUpsert path.
  const writeN = parseInt(arg("write-n", quick ? "100" : "300")!, 10);
  const burstN = parseInt(arg("burst-n", quick ? "500" : "2000")!, 10);
  const wUpdate = await bench.runWriteCase("write_update", writeN);
  const wBurst = await bench.runWriteCase("write_burst", burstN);
  // BEFORE baseline (17ec787): the full-rebuild structure cost each update paid.
  const baselineN = parseInt(arg("baseline-n", "5")!, 10);
  const baseline = await bench.baselineRebuild(Math.min(baselineN, writeN));
  results.push({ name: wUpdate.name, concurrency: 1, wall: wUpdate.wall, stmts: wUpdate.stmts });
  results.push({ name: wBurst.name, concurrency: 1, wall: wBurst.wall, stmts: wBurst.stmts });
  const write = {
    update: { p50: round(wUpdate.wall.p50), p95: round(wUpdate.wall.p95), max: round(wUpdate.wall.max), stmts: round(wUpdate.stmts.p50), n: writeN },
    burst: { count: burstN, drainMs: round(wBurst.totalMs), perUpdateP50: round(wBurst.wall.p50), perUpdateP95: round(wBurst.wall.p95), perUpdateMax: round(wBurst.wall.max), stmts: round(wBurst.stmts.p50) },
    baselineFullRebuild: { p50: round(baseline.p50), p95: round(baseline.p95), max: round(baseline.max) },
  };

  const info = await pgInfo();
  const byName = (n: string, conc = concurrencies[0]) => results.find((r) => r.name === n && r.concurrency === conc);
  const predictive = byName("predictive");
  const searchNf = byName("search_no_filter");
  const typo = byName("typo");

  const checks: TargetCheck[] = [];
  if (predictive) checks.push({ target: `predictive p95 (@${size})`, measured: round(predictive.wall.p95), limit: 60, unit: "ms", pass: predictive.wall.p95 <= 60 });
  if (searchNf) {
    const lim = size >= 100000 ? 250 : 150;
    checks.push({ target: `search+facets p95 (@${size})`, measured: round(searchNf.wall.p95), limit: lim, unit: "ms", pass: searchNf.wall.p95 <= lim });
  }
  if (typo && searchNf) {
    const delta = typo.wall.p95 - searchNf.wall.p95;
    checks.push({ target: "typo overhead p95", measured: round(delta), limit: 30, unit: "ms", pass: delta <= 30 });
  }
  // Phase 14c W3 target: per-update p50 <= 100 ms @10k (growth 10k->100k checked across runs).
  checks.push({ target: `write_update p50 (@${size})`, measured: round(wUpdate.wall.p50), limit: 100, unit: "ms", pass: wUpdate.wall.p50 <= 100 });

  const payload = {
    startedAt: started.toISOString(), size, seed, N, concurrencies,
    machine: { cores: os.cpus().length, ram_gb: round(os.totalmem() / 1e9), platform: process.platform, node: process.version },
    postgres: info,
    build: { ms: round(load.buildMs), docCount: load.docCount, rssDeltaMb: load.rssDeltaMb, stats: load.gen.stats },
    write,
    results, checks, topStmts: topStmts.map((t) => ({ sql: t.sql.slice(0, 200), maxMs: round(t.maxMs), count: t.count })),
  };
  const outDir = join(process.cwd(), "scripts", "bench", "out");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `bench-${size}.json`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeDoc(payload, explains);

  console.log("\n[bench] results (p50/p95/p99 ms, stmts/req):");
  for (const r of results) console.log(`  ${pad(r.name + " c" + r.concurrency, 28)} ${pad(round(r.wall.p50), 8)} ${pad(round(r.wall.p95), 8)} ${pad(round(r.wall.p99), 8)}  stmts~${round(r.stmts.p50)}`);
  console.log("\n[bench] targets:");
  for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${pad(c.target, 30)} ${c.measured}${c.unit} (limit ${c.limit}${c.unit})`);
  console.log(`\n[bench] wrote ${jsonPath} and docs/PHASE14_BENCH.md`);
  await bench.close();
  // exit success even on FAIL (the report records it); the workflow reads the JSON
}

const round = (x: number) => Math.round(x * 100) / 100;
const pad = (s: string | number, n: number) => String(s).padEnd(n);

function writeDoc(p: ReturnType<typeof Object> & Record<string, any>, explains: { sql: string; plan: string }[]): void {
  const lines: string[] = [];
  lines.push(`# Phase 14 — Benchmark results`, "");
  lines.push(`**Run:** ${p.startedAt} · size **${p.size}** products · seed ${p.seed} · N=${p.N} · concurrency ${p.concurrencies.join("/")}.`, "");
  lines.push(`> **Indicative numbers — single shared sandbox node, not production.** Absolute latency on a shared container is not representative; use the hosted \`benchmark.yml\` workflow for comparable figures. Relative comparisons (before/after, per-query, statement counts) and the EXPLAIN plans are meaningful here.`, "");
  lines.push(`## Machine`, "");
  lines.push(`- Cores: ${p.machine.cores} · RAM: ${p.machine.ram_gb} GB · ${p.machine.platform} · Node ${p.machine.node}`);
  lines.push(`- PostgreSQL ${p.postgres.version} · shared_buffers=${p.postgres.shared_buffers} · work_mem=${p.postgres.work_mem} · effective_cache_size=${p.postgres.effective_cache_size}`, "");
  lines.push(`## Build (real sync→index path)`, "");
  lines.push(`- ${p.build.docCount} docs in **${p.build.ms} ms**, RSS Δ ${p.build.rssDeltaMb} MB.`);
  lines.push(`- Dataset: ${JSON.stringify(p.build.stats)}`, "");
  lines.push(`## Query latency (ms) and statements/request`, "");
  lines.push(`| case | conc | p50 | p95 | p99 | stmts (p50) |`, `|---|---|---|---|---|---|`);
  for (const r of p.results) lines.push(`| ${r.name} | ${r.concurrency} | ${round(r.wall.p50)} | ${round(r.wall.p95)} | ${round(r.wall.p99)} | ${round(r.stmts.p50)} |`);
  lines.push("", `## Targets (F14) — PASS/FAIL`, "");
  lines.push(`| target | measured | limit | result |`, `|---|---|---|---|`);
  for (const c of p.checks) lines.push(`| ${c.target} | ${c.measured}${c.unit} | ${c.limit}${c.unit} | **${c.pass ? "PASS" : "FAIL"}** |`);
  lines.push("", `## Heaviest statements — EXPLAIN (ANALYZE, BUFFERS)`, "");
  for (const e of explains) {
    lines.push("```sql", e.sql.slice(0, 500), "```", "```", e.plan.split("\n").slice(0, 12).join("\n"), "```", "");
  }
  lines.push(`## Methodology & limits`, "");
  lines.push(`- Data loaded through \`runFullSync\` (parse → upsert → buildDocs → validate → activate), identical to production.`);
  lines.push(`- Queries run in-process over the \`app_runtime\` role with RLS enabled+forced and the per-tenant \`app.shop_id\` GUC set — never as owner.`);
  lines.push(`- Each case: 10 warm-up iterations, then N measured; percentiles are nearest-rank over wall-clock per request. Statements/request counted by instrumenting the Exec.`);
  lines.push(`- EXPLAIN runs ANALYZE (so it executes) on the heaviest distinct statement shapes seen during a single-threaded profiling pass.`);
  lines.push(`- Sandbox caveat: shared CPU, default PG config; treat absolute ms as indicative only.`);
  writeFileSync(join(process.cwd(), "docs", "PHASE14_BENCH.md"), lines.join("\n") + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
