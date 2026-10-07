-- Migration 0009 — Phase 6: semantic layer / NL query parser.
-- Applied by app_owner. Additive, idempotent-from-scratch on PostgreSQL 16.
-- No new extension, no new scope. One new tenant table (RLS enabled+forced) plus
-- two additive columns used only for the "newest" / price sort hints.

-- ---------------------------------------------------------------------------
-- Per-shop attribute dictionary: phrase -> (facet, value). Lets the NL parser
-- map words like "red" / "large" / "cotton" onto the EXISTING filterable facets
-- (tags / metafield / product_type / vendor). Admin-managed; sensible English
-- defaults live in app/lib/search/attributes.ts (defaults + per-shop overrides,
-- like stop words). Values are applied through the same normalizeFilters()
-- validation as manual filter params.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "search_attribute_term" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"    UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "phrase"     TEXT NOT NULL,
  "facet"      TEXT NOT NULL CHECK ("facet" IN ('tags','metafield','product_type','vendor')),
  "value"      TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "search_attribute_term_uniq" ON "search_attribute_term"("shop_id","phrase");
CREATE INDEX IF NOT EXISTS "search_attribute_term_shop_idx" ON "search_attribute_term"("shop_id");

-- ---------------------------------------------------------------------------
-- Shopify product createdAt (read_products), captured so the "newest" sort hint
-- has real data. Mirrored onto product_search_doc (computed in the shared
-- docInsertSql, like every other indexed field) so sorting stays within the
-- active version's docs.
-- ---------------------------------------------------------------------------
ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "product_created_at" TIMESTAMPTZ;
ALTER TABLE "product_search_doc" ADD COLUMN IF NOT EXISTS "created_at_shopify" TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS "psd_created_shopify_idx"
  ON "product_search_doc" ("shop_id","index_version_id","created_at_shopify");

-- ===========================================================================
-- Grants + RLS (ENABLE + FORCE) for the Phase 6 tenant table. Same pattern as
-- Phases 2/5. DROP POLICY IF EXISTS makes re-application safe.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "search_attribute_term" TO app_runtime;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['search_attribute_term'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (shop_id = app_current_shop()) WITH CHECK (shop_id = app_current_shop());',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
