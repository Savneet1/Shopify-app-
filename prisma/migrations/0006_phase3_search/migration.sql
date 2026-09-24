-- Migration 0006 — Phase 3: search schema + result-card data.
-- Applied by app_owner. pg_trgm and unaccent are TRUSTED extensions since PG13,
-- so the (non-superuser) database owner can install them. On managed Postgres
-- (RDS/Cloud SQL/Azure) both are on the supported-extensions list; if a provider
-- disallows CREATE EXTENSION for the app role, an admin enables them once.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is only STABLE, so it cannot be used directly in an indexed/stored
-- expression. This IMMUTABLE wrapper pins the 'unaccent' dictionary (fixed at
-- deploy) so to_tsvector(immutable_unaccent(...)) can be stored/indexed.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
SET search_path = public, pg_catalog
AS $$ SELECT public.unaccent('public.unaccent', $1) $$;
GRANT EXECUTE ON FUNCTION immutable_unaccent(text) TO app_runtime;

-- Result-card fields (read_products object scope; verified 2026-09-22).
ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "featured_image_url" TEXT;
ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "featured_image_alt" TEXT;
-- onlineStoreUrl is NULL when a product is NOT published to the Online Store
-- sales channel; storefront search uses it as the publication signal.
ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "online_store_url" TEXT;
ALTER TABLE "variant"  ADD COLUMN IF NOT EXISTS "compare_at_price" NUMERIC(12,2);

-- Search columns on the versioned documents. Computed inside the shared
-- docInsertSql (build / in-place refresh / activation catch-up) so all three
-- paths stay identical.
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "tsv" tsvector;
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "sku_text" TEXT;
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "status" TEXT;
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "published" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "available" BOOLEAN NOT NULL DEFAULT false;

-- Full-text (weighted tsvector) + trigram (prefix/substring acceleration and
-- the last-resort fallback only — NOT typo tolerance, which is Phase 5).
CREATE INDEX IF NOT EXISTS "psd_tsv_gin" ON "product_search_doc" USING gin ("tsv");
CREATE INDEX IF NOT EXISTS "psd_title_trgm" ON "product_search_doc" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "psd_sku_trgm" ON "product_search_doc" USING gin ("sku_text" gin_trgm_ops);
-- Storefront filter (active + published) within a version.
CREATE INDEX IF NOT EXISTS "psd_filter" ON "product_search_doc" ("shop_id", "index_version_id", "published", "status");
