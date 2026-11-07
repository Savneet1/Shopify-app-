-- Migration 0021 — Phase 14.2 gid-lookup index on product_search_doc.
-- Applied by app_owner. Additive + idempotent (CREATE INDEX IF NOT EXISTS).
-- No new scope/extension/dependency, NO SECURITY DEFINER function, RLS unchanged.
--
-- WHY (measured): the Phase 14 benchmark EXPLAIN (ANALYZE, BUFFERS) at 100k showed
-- the recommendation "seeds" CTE doing a Seq Scan on product_search_doc with
-- "Rows Removed by Filter: 99999" just to resolve ONE seed product by
-- shopify_product_gid. There was no index covering a gid lookup on this table
-- (existing indexes lead with vendor/product_type/price/published-status or
-- product_id). The same shop_id+gid lookup shape is used by at least five public
-- paths: recommendations (similar/related seed resolution, content.ts &
-- signals.ts), bundle resolution (bundles/model.ts), merchandising rule targets
-- (merch/rules.ts) and back-in-stock subscription/availability (restock/*.ts).
--
-- A single composite btree on (shop_id, shopify_product_gid) serves all of them:
-- gid is near-unique per shop (one row per index version, typically 1-2 live
-- versions), so a (shop_id, gid=ANY) index scan returns a handful of rows and the
-- residual equality on index_version_id/published/status is applied to those few
-- rows instead of sequentially scanning the whole catalog. Results are
-- byte-identical; only query PLANS change. The extra index adds a small per-row
-- write cost during the (background) index build, traded for faster reads on the
-- hot public gid-lookup paths.

CREATE INDEX IF NOT EXISTS "psd_gid_btree"
  ON "product_search_doc" ("shop_id", "shopify_product_gid");
