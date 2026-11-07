# Phase 14 — Performance measurement, optimization & security hardening

**Base** `2253b9a` (Phase 13b), fast-forward. No new Shopify scope, no new npm
dependency (two version **overrides** only), no new PostgreSQL extension, no new
SECURITY DEFINER function. New migrations are additive + idempotent (**0020**,
**0021**). Behaviour is byte-identical: all prior tests pass and none were
weakened (806 passed | 13 skipped, `npm test` == `test:ci-parity`).

> **All latency numbers in this phase are from a single shared sandbox node and
> are INDICATIVE, not production.** Absolute ms on a shared container are not
> representative. Relative comparisons (before/after, per-query, statement
> counts) and the EXPLAIN plans are meaningful. Use the manual
> `.github/workflows/benchmark.yml` to get numbers on hosted hardware.

---

## 14.1 Benchmark harness

`scripts/bench/` + `npm run bench -- --size=N [--n=200] [--seed=1337] [--quick]`.
Committed, repeatable, and **not** part of `npm test`.

- **gen.ts** — deterministic synthetic catalog (mulberry32, fixed seed): 40
  vendors, 25 product types, 150-tag pool, 1–5 variants, log-spread prices,
  ~5% draft / ~3% archived / ~8% unpublished / ~10% unavailable, ~2% combined
  parents with 2–4 children, a metafield, collections. Emits Shopify bulk-op
  JSONL so it loads through the **real** `runFullSync` (parse → upsert →
  buildDocs → validate → activate).
- **harness.ts** — loads the catalog (measures build wall-ms + RSS delta),
  then times the public query paths **as `app_runtime` with RLS on** (never as
  owner): predictive, search (0/1/3 filters), typo, NL, browse/facets,
  recommendations (similar/related/trending), combined-mode search. Warm-up +
  N measured iterations at concurrency 1 and 8; records SQL statements/request;
  EXPLAIN (ANALYZE, BUFFERS) on the 10 heaviest statements.
- **percentiles.ts** — nearest-rank p50/p95/p99.
- **run.ts** — CLI; writes `scripts/bench/out/bench-<size>.json` and
  `docs/PHASE14_BENCH.md`; prints PASS/FAIL vs the F14 targets.
- Harness self-tests in `test/phase14-bench-harness.test.ts` (generator
  determinism + percentile math).
- **Manual** CI workflow `.github/workflows/benchmark.yml` (`workflow_dispatch`,
  Postgres service, runs 10k + 100k, uploads JSON/markdown). The existing Live
  Prisma Check workflow is unchanged (only a non-blocking `npm audit` summary
  step was added — 14.5).

## 14.2 Optimization — only what the measurements showed

The harness measured each suspect. Two findings were **safe, additive, and
byte-identical**; the rest are algorithmic and are documented honestly rather
than papered over by tuning the benchmark.

### Finding A — stale planner statistics after a bulk build (→ migration 0020)
Right after a bulk sync+index build, `pg_class` stats are stale (`reltuples≈1`),
so the planner estimates `product_search_doc` as tiny and chooses a
shop-index-scan + in-memory filter (EXPLAIN showed `Rows Removed by Filter:
9999`) instead of the purpose-built indexes. `app_runtime` is not a table owner
and PG16 has no `MAINTAIN` privilege, so the app cannot `ANALYZE` and we add no
SECURITY DEFINER wrapper. **Migration 0020** lowers the autovacuum
analyze/vacuum thresholds on `product_search_doc`, `product`, `variant` so fresh
statistics arrive promptly. `test/phase14-index-usage.test.ts` asserts (at a 10k
synthetic set, after ANALYZE) that a selective vendor equality uses an index
scan — not a `Seq Scan on product_search_doc`.

### Finding B — no gid-lookup index on product_search_doc (→ migration 0021)
The 100k EXPLAIN showed the recommendation **seed** CTE doing a `Seq Scan on
product_search_doc` with `Rows Removed by Filter: 99999` to resolve ONE seed by
`shopify_product_gid`. No index covered a gid lookup, yet **five** public paths
look rows up by `(shop_id, …, shopify_product_gid)`: recommendations
(`content.ts`, `signals.ts`), bundle resolution (`bundles/model.ts`), merch rule
targets (`merch/rules.ts`), and back-in-stock subscribe/availability
(`restock/*.ts`). **Migration 0021** adds `psd_gid_btree (shop_id,
shopify_product_gid)`; gid is near-unique per shop so the index scan returns a
handful of rows and the residual equality is applied to those. Proven by
`test/phase14-index-usage.test.ts` (index scan, not seq scan). Trade-off: one
extra index maintained during the (background) build, for faster reads on hot
public gid-lookup paths.

### What was NOT changed, and why
- **Recommendation candidate scan** (`recommend/content.ts`): after the seed is
  found, similar/related **score every visible doc by trigram similarity** —
  the 100k heavy path (~2.3 s on the bench node). This is **algorithmic** (it is
  meant to compare the seed against the catalog), not an index miss. A faster
  version needs a precomputed candidate/cache layer, which the phase rules only
  permit with proof it is tenant/locale/context-safe and tested — not added
  speculatively, and never Redis. Documented as the path to hit the target on
  production hardware.
- **Suggestion/"visible" scan** (`search/suggest.ts`) and **facet counts**
  (`search/facets.ts`): inherently O(visible docs in the result) aggregates.
  Index usage is correct; the cost is the aggregate itself.
- **Per-request setting lookups** (suspect 5): statement counts are bounded
  (predictive 14, search 18, typo 19, rec 8, browse 13 — see bench). A
  `getActiveVersion` dedupe would shave a couple of statements but touches hot
  signatures across many call sites; deferred as higher-risk-than-reward and
  recorded as a follow-up.

### Before / after (indicative, 100k, shared node)
| Path | Before (no fresh stats) | After (0020 + 0021) | Note |
|---|---|---|---|
| rec seed resolution | `Seq Scan`, Rows Removed 99 999 | index scan via `psd_gid_btree` | measured in EXPLAIN |
| selective vendor/filter search | shop-index + in-memory filter (stale stats) | index scan on the selective predicate | asserted by test |
| rec candidate scoring | ~2.3 s (algorithmic) | unchanged (algorithmic) | documented, not met on shared node |

## 14.3 Large-catalog behaviour at 100k

- **Build**: 100 000 docs (295 482 variants, 1 653 combined parents) built
  through the real sync→index path in **~358 s** with an **RSS delta of 45 MB**
  — memory does **not** scale with catalog size (10k built with an 85 MB delta;
  the bulk parse/stream + batched doc writes keep peak memory bounded). The
  atomic activation swap flips a single active-version pointer; readers always
  see one consistent version (no partial index visible).
- **Statements/request stay bounded** at 100k (8–19), i.e. per-request work does
  not grow with the catalog — the growth is in rows scanned by the algorithmic
  paths, addressed above.
- Resumability, webhook-burst drain and maintenance-tick cost rely on the
  existing singleton/running-guard + bounded-batch machinery from Phases 2/9/11;
  no regressions were observed building/activating at 100k. (A full 5 000-update
  burst drain-time figure is **Requires-Verification** on hosted hardware; see
  the report.)

## 14.4 Security hardening

See `docs/PHASE14_SECURITY.md` for the full table. Each item has a test
(`phase14-statement-timeout`, `phase14-authz-audit`, `phase14-rls-completeness`,
`phase14-egress-audit`, `phase14-security-headers`, `phase14-log-redaction`).
Summary: a 2 s `SET LOCAL statement_timeout` on every public proxy query path
(slow query → native fallback, never 5xx); rate-limit + body-size audit of every
public endpoint; authorization, RLS-completeness and egress static audits
(three of these guards were **mutation-tested**); security headers (CSP
frame-ancestors + nosniff + Referrer-Policy on admin, nosniff + no-store on proxy
JSON); generic error bodies; log redaction; `/healthz` (DB-connectivity only)
and a shop-hashed slow-operation log line.

## 14.5 Dependency audit

Full assessment in `docs/PHASE14_SECURITY.md`. Semver-compatible overrides
(`body-parser@1.20.9`, `qs@6.17.1`) applied and verified — the two fixable
advisories are cleared; the suite still passes. The remaining 5 high advisories
are the `prisma 7` / `zod 4` **major** upgrades, which the phase rules forbid
without approval — each has an exploitability assessment and an upgrade plan;
**proposed, not applied**. A non-blocking `npm audit --omit=dev` step was added
to the existing workflow.

## 14.6 Carry-overs

- **(a)** A combined parent with zero visible children now OMITS the range keys
  (no `priceMin/priceMax: null`). (Phase 13b C1 + `phase13-combined` test.)
- **(b)** `hydratedPriceString` returns `null` (keeping the indexed price) when
  the currency is missing/invalid, never a bare number. (`phase13-hydration`.)
- **(c)** Analytics rollup — see below.

### 14.6c — analytics daily rollup (MEASURED, then implemented)
The 90-day report queries aggregate the whole window of raw `analytics_event`
each call. Measured per shop on the bench node:

| Report | 10k events/day (900k rows) | 100k events/day (9M rows) |
|---|---|---|
| summaryReport | ~230 ms | ~2 000 ms |
| topQueries | ~380 ms | ~4 550 ms |
| dailyTrend | ~430 ms | ~4 500 ms |

At the common load (10k/day) reports are fine; at 100k/day they miss a sensible
interactive bound. So the **bounded daily rollup** was implemented:
`app/lib/analytics/rollup.ts` rolls COMPLETED days of `analytics_event` into the
pre-existing `analytics_rollup_daily (shop_id, day, event_type, surface,
event_count)`. The long-range event_type/surface reports (`summaryReport`,
`dailyTrend`, `perSurface`) read the rollup for the completed window and raw
only for the current (partial) day:

| Report (90-day, completed portion) | raw @100k/day | rollup |
|---|---|---|
| summary / trend / per-surface | ~2 000–4 500 ms | **~1–2 ms** (≈4 500 rollup rows, volume-independent) |

**Design guarantees**
- Only days strictly before "today" (UTC) are rolled up; a completed day is
  immutable (server-clock `occurred_at`), so a rollup day equals the raw
  aggregate exactly → the report's rollup path is **byte-identical** to raw
  (proven by `test/phase14-analytics-rollup.test.ts`: run 90-day reports on raw,
  populate the rollup, run again — assert deep-equal).
- **Bounded + converging**: each maintenance tick re-rolls the 2 most recent
  completed days and extends the rolled range back by ≤14 days, scanning at most
  ~16 days of raw per shop (never the whole window); it converges to full
  coverage over successive ticks. Idempotent (DELETE+INSERT per day).
- **Gated to long-range windows** (completed span > 45 days): short windows
  (e.g. the 30-day dashboard default) and any not-yet-covered window take the
  original single raw aggregate unchanged — so existing report tests and query
  counts are untouched.
- The per-query reports (`topQueries`/`topZeroResultQueries`/
  `queriesWithNoClicks`) deliberately stay on raw: the rollup stores **no query
  text** by design (migration 0013), a privacy choice, so it cannot and must not
  serve them.
- Wired into the existing maintenance tick (`runAnalyticsRollup`, per shop,
  RLS-scoped); rollup retention is the pre-existing `purgeOldAnalyticsRollup`
  (400-day cap). No new queue, scope, dependency or migration.

## Migrations added
- **0020** `phase14_autovacuum_stats` — autovacuum analyze/vacuum thresholds on
  `product_search_doc`, `product`, `variant` (plan-stat freshness).
- **0021** `phase14_psd_gid_index` — `psd_gid_btree (shop_id,
  shopify_product_gid)` on `product_search_doc` (gid-lookup index).

## Tests added
`phase14-bench-harness`, `phase14-index-usage`, `phase14-statement-timeout`,
`phase14-authz-audit`, `phase14-rls-completeness`, `phase14-egress-audit`,
`phase14-security-headers`, `phase14-log-redaction`, `phase14-analytics-rollup`,
plus the 13b carry-over assertions in `phase13-combined` / `phase13-hydration`.
