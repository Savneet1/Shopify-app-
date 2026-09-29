-- Migration 0007 — Phase 4: filters & facets.
-- Applied by app_owner. Additive only. Materialises facet-relevant fields as
-- INDEXED COLUMNS on product_search_doc so facet counts are computed from the
-- SAME rows (and the SAME shared docInsertSql) as search results — facets can
-- never drift from what search returns.
--
-- Note vs the Phase 4 scope note: Phase 3 stored vendor / product_type /
-- price_min / price_max only inside the doc JSONB, NOT as columns. Phase 4
-- promotes them to indexed columns here (still computed in the one shared
-- docInsertSql — no second computation site, no drift).

-- Product-level metafields capture for the ONE proof-of-concept facet (and the
-- extension point). Stored as a flat { "namespace.key": "value" } map for the
-- configured facet namespace only (read via the existing read_products scope;
-- which metafields are actually returned depends on each metafield's access
-- controls — REQUIRES VERIFICATION per store, documented in docs/PHASE4.md).
ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "metafields" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Facet columns on the versioned documents. Populated inside the shared
-- docInsertSql (build / in-place refresh / activation catch-up) so all three
-- paths stay identical.
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "vendor" TEXT;
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "product_type" TEXT;
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "price_min" NUMERIC(12,2);
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "price_max" NUMERIC(12,2);
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "metafields" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Multi-value / containment facets -> GIN.
CREATE INDEX IF NOT EXISTS "psd_tags_gin" ON "product_search_doc" USING gin ("tags");
CREATE INDEX IF NOT EXISTS "psd_metafields_gin" ON "product_search_doc" USING gin ("metafields" jsonb_path_ops);
-- Single-value / range facets -> btree, scoped by shop+version so a facet scan
-- stays within one shop's active index.
CREATE INDEX IF NOT EXISTS "psd_vendor_btree" ON "product_search_doc" ("shop_id", "index_version_id", "vendor");
CREATE INDEX IF NOT EXISTS "psd_ptype_btree" ON "product_search_doc" ("shop_id", "index_version_id", "product_type");
CREATE INDEX IF NOT EXISTS "psd_price_btree" ON "product_search_doc" ("shop_id", "index_version_id", "price_min", "price_max");
