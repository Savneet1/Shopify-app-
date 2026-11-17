# Phase 14d — Write/read performance robust to stale planner statistics

**Base:** `eb029b0` (Phase 14c). No new scope, dependency, or extension. One new
migration (`0026`, additive/idempotent). No new SECURITY DEFINER function. RLS
unchanged. READ results byte-identical.

## The problem (X1)

Phase 14c made structure maintenance an O(changed) delta: every product write
reads `product_search_doc` by `(shop_id, index_version_id, product_id = ANY($ids))`
and upserts into the four derived tables. Those plans are only O(changed) if the
planner drives the lookup from the unique index
`product_search_doc_version_product_key (shop_id, index_version_id, product_id)`.

Immediately after a bulk sync + index build that is **not** what happens.
`pg_class.reltuples` for `product_search_doc` is **-1** — "never analyzed". A
plain bulk `INSERT` does not refresh it; only `VACUUM`, `ANALYZE`, or
`CREATE INDEX` do, and the indexes pre-exist (the table is not recreated per
build). With no row estimate the planner estimates the per-product lookup at
**~1 row** and picks a shop-scoped index (`product_search_doc_shop_idx`, shop_id
only), then filters everything else in memory — reading the **whole shop catalog**
per statement. Measured stale plan of the Phase 14c vocabulary-subtract statement
at 10k (EXPLAIN ANALYZE, BUFFERS):

```
Index Scan using product_search_doc_shop_idx on product_search_doc psd
  (cost=0.29..4.31 rows=1 width=182) (actual ... rows=5 loops=1)
  Index Cond: (shop_id = '…')
  Filter: (published AND (index_version_id = '…') AND (status = 'ACTIVE')
           AND (product_id = ANY ('{…5 ids…}')))
  Rows Removed by Filter: 9995          ← scans all 10k, keeps 5
  Buffers: shared hit=2567
Execution Time: 10.837 ms
```

Note `cost=…rows=1` (the estimate) vs `Rows Removed by Filter: 9995` (reality).
Every delta statement regresses the same way. End-to-end this is a ~35x
write-path slowdown that persists until statistics are refreshed.

Measured per-statement (10k, stale vs after ANALYZE), via the bench harness
(`explainDeltaWritePath`):

| delta statement | stale index on product_search_doc | stale rowsRemoved | stale buffers | fresh index | fresh buffers |
|---|---|---|---|---|---|
| vocab delta | `product_search_doc_shop_idx` | 9999 | 2555 | `product_search_doc_version_product_key` | 140 |
| facet_value delta | `product_search_doc_shop_idx` | 9999 | 12078 | `…_version_product_key` | 87 |
| suggest delta | `product_search_doc_shop_idx` | 9999 | 9650 | `…_version_product_key` | 59 |
| facet_summary delta | `product_search_doc_shop_idx` | 9999 | 2405 | `…_version_product_key` | 7 |

## Why no query rewrite alone fixes it (X2b — measured, rejected)

The write path was already the clean 14c form; the question was whether a
stats-independent rewrite could force the unique index while `reltuples = -1`.
Measured, at 10k with stale stats, on the vocabulary-subtract statement
(EXPLAIN ANALYZE):

| variant | index chosen | buffers | exec |
|---|---|---|---|
| 14c `product_id = ANY($ids)` | shop_idx (full shop scan) | 3413 | 10.0 ms |
| `unnest($ids) JOIN product_search_doc` | shop_idx (full shop scan) | 3429 | 15.5 ms |
| `unnest` + `enable_hashjoin/mergejoin=off` | shop_idx | 3365 | 15.0 ms |
| `… + enable_seqscan=off` | shop_idx | 3342 | 13.6 ms |
| LATERAL-correlated subquery | shop_idx | 3364 | 14.5 ms |
| LATERAL + `OFFSET 0` fence | shop_idx, per-id ×5 | 13377 | 61.4 ms (worse) |
| **any variant, after ANALYZE** | **unique index** | ~900 | ~1.9 ms |

The mis-estimate is on index **selectivity** of a never-analyzed table, not on a
join method or a seq-vs-index choice, so join rewrites and
`enable_seqscan/hashjoin/mergejoin` do not move it; the `OFFSET 0` fence forces a
per-id nested loop but each probe still picks the shop index (estimated 1 row) and
scans the whole shop, making it worse. Fresh statistics fix **every** variant,
and the existing 14c statement already uses the unique index once stats exist.

**Decision:** do **not** rewrite the delta statements. A rewrite is neither
sufficient (stale) nor necessary (fresh), and rewriting would force re-proving the
14c byte-identical property/concurrency/read-equivalence suite for no measured
gain. The robust fix is to make statistics fresh (X2c) and keep them fresh (X2a).

## The fix

### X2c — automatic post-build ANALYZE (primary)

> **Superseded by Phase 14e.** As shipped in 14d, `runPostBuildAnalyze()` used the
> migration **owner** connection (`DIRECT_DATABASE_URL` = `app_owner`). That put
> the owner credential in the worker runtime for the first time — too much
> authority for a stats refresh. **Phase 14e replaced it with a dedicated
> least-privilege role `app_maintenance` (`MAINTENANCE_DATABASE_URL`) that owns
> only the seven build-output tables**, and removed the `DIRECT_DATABASE_URL`
> fallback, added connect/statement/overall timeouts, a self-heal tick and an
> admin notice. See `docs/PHASE14E.md` (and its "Privilege model" section). The
> description below is the 14d design, kept for history.

`app/lib/jobs/analyze.server.ts` `runPostBuildAnalyze()` opens a short-lived
maintenance connection and runs `ANALYZE` on a **fixed module-constant allowlist**
(`product_search_doc`, `product`, `variant`, and the four derived tables). It is
wired into the full-sync handler (`handleCatalogSyncFull`) as an injected,
best-effort step that runs after a successful build and never fails the sync.

This is automatic — not a manual `ANALYZE` — so the write path has fresh
statistics the moment a build completes, closing the stale window at its source.

**Privilege implications.** `ANALYZE` requires table ownership. `app_runtime` is
`NOSUPERUSER`/`NOBYPASSRLS` and is not a table owner, and PostgreSQL 16 has no
`MAINTAIN` privilege, so the app role cannot `ANALYZE`. The two options were:

- **Option 1 (chosen in 14d, revised in 14e):** a maintenance-only client that does
  nothing but `ANALYZE` on the fixed allowlist. It takes no input, touches no tenant
  rows, and grants `app_runtime` **no** new capability.
  **Correction (finding, Phase 14e):** 14d described this as reusing
  `DIRECT_DATABASE_URL` and claimed the worker "already" has it in CI/prod "for
  migrations and pg-boss". That was wrong: pg-boss connects with
  `BOSS_DATABASE_URL || DATABASE_URL` (the `app_runtime` role), and before 14d **no
  runtime code read `DIRECT_DATABASE_URL`** — migrations run as a separate step, not
  in the worker. 14d therefore introduced the owner credential into the worker
  runtime for the first time. Phase 14e corrects this by using a dedicated
  least-privilege `MAINTENANCE_DATABASE_URL` (`app_maintenance`) instead, with no
  owner credential at runtime. If it is absent, the refresh is a logged no-op and
  the system falls back to autovacuum (Option 0 / X2a).
- **Option 2 (not taken):** a no-argument, allowlisted `SECURITY DEFINER`
  function. Rejected because Option 1 needs no new database object and no entry on
  the definer allowlist — strictly less surface.

### X2a — autovacuum reloptions on the derived tables (durability)

Migration `0026` gives the four derived tables the same aggressive
`autovacuum_analyze_scale_factor = 0.02 / threshold = 500` that migration `0020`
gave `product_search_doc`/`product`/`variant`. Before this they had **no**
reloptions and inherited the cluster default `analyze_scale_factor = 0.1`.

**Why `product_search_doc` was not auto-analyzed in the maintainer's run even
with 0020's reloptions.** Autovacuum is asynchronous and best-effort: the launcher
wakes every `autovacuum_naptime` (default **60 s**) and workers are bounded
(`autovacuum_max_workers`, default 3) with cost-based delays. Right after a bulk
load, `product_search_doc` is simultaneously over its vacuum **and** analyze
thresholds, and a large table's autovacuum vacuum pass can precede/defer the
analyze; combined with naptime and worker contention this leaves a window of tens
of seconds to minutes where `reltuples` is still -1 — exactly the window a webhook
write can land in. Reloptions lower the *threshold* but cannot make the refresh
*synchronous*. Hence the post-build ANALYZE (X2c) is the actual guarantee;
reloptions are the steady-state net that keeps stats fresh after incremental drift
and if the synchronous refresh is ever skipped.

## Proof (X3)

`test/phase14d-plan-stability.test.ts` bulk-loads 2500 docs, captures the **real**
delta statements from a live `applyProductUpsert`, and asserts via EXPLAIN:

- **fix:** after the post-build `ANALYZE`, every delta statement uses
  `product_search_doc_version_product_key` and never Seq-Scans `product_search_doc`;
- **guard (mutation test):** with statistics stale (as right after a raw build,
  autovacuum pinned off for the test), the vocabulary delta does **not** use the
  unique index — so if the post-build `ANALYZE` were removed the write path is left
  on the regressed plan. The assertion fails if stale no longer regresses.

Plan assertions (not timing) are the proof; the harness additionally reports a
generous end-to-end time bound (X4).

## Limitations

- The guarantee depends on the worker having the maintenance connection
  (`MAINTENANCE_DATABASE_URL` as of Phase 14e; `DIRECT_DATABASE_URL` in 14d as
  shipped). Without it the post-build ANALYZE is a logged no-op and freshness falls
  back to autovacuum (correct, but with the async window above). Phase 14e adds a
  self-heal tick and an admin notice so a missing/failing maintenance connection is
  detected and surfaced rather than silent.
- The post-build ANALYZE is a full ANALYZE of seven tables; it is bounded (fixed
  list, runs once per build) and cheap relative to the build it follows.
- Incremental writes between full builds keep `reltuples` approximately valid and
  the reloptions trigger autovacuum on drift; the synchronous refresh is tied to
  the build (the only point that bulk-invalidates stats).
