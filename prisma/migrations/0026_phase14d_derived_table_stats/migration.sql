-- Migration 0026 — Phase 14d planner-statistics freshness on the DERIVED
-- precompute tables. Applied by app_owner. Additive + idempotent (ALTER ... SET
-- is re-runnable). No new scope/extension/dependency, NO SECURITY DEFINER
-- function, RLS unchanged. Results byte-identical; only query PLANS change.
--
-- WHY: Phase 14c moved structure maintenance onto an incremental delta path whose
-- statements read product_search_doc by (shop_id, index_version_id, product_id)
-- and upsert into the four derived tables. Phase 14d measurement (docs/PHASE14D.md)
-- showed that immediately after a bulk sync+index build, pg_class.reltuples for
-- product_search_doc is -1 (a plain bulk INSERT never refreshes it; only
-- VACUUM/ANALYZE/CREATE INDEX do, and the indexes pre-exist), so the planner
-- estimates the per-product lookup at ~1 row and scans the whole shop via the
-- shop-only index (Rows Removed by Filter ≈ catalog size) instead of the unique
-- (shop_id, index_version_id, product_id) index — a ~35x write-path regression
-- that persists until statistics are refreshed. No query rewrite or per-statement
-- planner GUC escapes this misestimate (measured: unnest-join, LATERAL, and
-- LATERAL+OFFSET-0 all still pick the shop index; enable_seqscan/hashjoin/
-- mergejoin=off do not help) — only fresh statistics fix it.
--
-- Migration 0020 gave product_search_doc/product/variant aggressive autovacuum
-- analyze thresholds, but (a) the four derived tables below had NO reloptions, so
-- they inherited the cluster defaults (analyze_scale_factor 0.1), and (b)
-- autovacuum is asynchronous (autovacuum_naptime default 60s, bounded workers,
-- cost-based delays), so it cannot guarantee fresh statistics *immediately* after
-- a build. Phase 14d therefore (1) adds matching reloptions here so the derived
-- tables are analyzed promptly on drift, and (2) adds a SYNCHRONOUS owner-side
-- post-build ANALYZE in the build pipeline (app/lib/jobs/analyze.server.ts) so the
-- write path has fresh stats the moment a build completes, without app_runtime
-- gaining any privilege and without a SECURITY DEFINER function.

ALTER TABLE "search_vocabulary" SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500,
  autovacuum_vacuum_scale_factor = 0.05
);
ALTER TABLE "search_facet_value" SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500,
  autovacuum_vacuum_scale_factor = 0.05
);
ALTER TABLE "search_facet_summary" SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500
);
ALTER TABLE "search_suggest_term" SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500,
  autovacuum_vacuum_scale_factor = 0.05
);
