-- Migration 0020 — Phase 14.2 planner-statistics freshness on the hot tables.
-- Applied by app_owner. Additive + idempotent (ALTER ... SET is re-runnable).
-- No new scope/extension/dependency, NO SECURITY DEFINER function, RLS unchanged.
--
-- WHY: EXPLAIN (ANALYZE) during the Phase 14 benchmark showed that right after a
-- bulk sync+index build, pg_class stats were stale (reltuples≈1), so the planner
-- mis-estimated product_search_doc as tiny and chose shop-index-scan + in-memory
-- filter (removing thousands of rows) instead of the purpose-built partial/column
-- indexes. app_runtime is NOT a table owner and PostgreSQL 16 has no MAINTAIN
-- privilege, so the app cannot run ANALYZE itself and we must NOT add a SECURITY
-- DEFINER wrapper. Instead we make autovacuum ANALYZE these tables far sooner
-- after a large change, so fresh statistics arrive promptly and the planner uses
-- the right indexes at 100k. Results are byte-identical; only query PLANS change.
--
-- (The benchmark harness additionally runs an explicit owner-side ANALYZE after
-- load to report representative steady-state plans; production relies on these
-- autovacuum settings + the normal autovacuum daemon.)

ALTER TABLE "product_search_doc" SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500,
  autovacuum_vacuum_scale_factor = 0.05
);
ALTER TABLE "product" SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500
);
ALTER TABLE "variant" SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500
);
