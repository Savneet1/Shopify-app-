-- Migration 0022 — Phase 14b P3/P4: per-index-version precomputed facet values
-- and summary, so the NL parse-context (distinct vendor/type/tag/metafield) and
-- the UNFILTERED browse facet counts read a small table instead of scanning
-- every visible doc per request. Additive + idempotent. No new scope/extension/
-- dependency, NO SECURITY DEFINER function.
--
-- Keyed by index_version_id with ON DELETE CASCADE (same as search_vocabulary),
-- so the tables follow the atomic swap / rollback and are purged automatically
-- when pruneOldVersions deletes an index_version row (retention/cascade). RLS
-- ENABLED + FORCED with a tenant policy; app_runtime-only DML. Maintained by the
-- SAME code path that rebuilds search_vocabulary (rebuildVocabulary), which runs
-- after every doc-writing path (full build, incremental refresh, activation
-- catch-up, collection-member refresh, reindex).

-- Distinct facet values + visible-doc counts, one row per (version, kind, value).
--   kind ∈ {'vendor','product_type','tag','metafield','available'}
CREATE TABLE IF NOT EXISTS "search_facet_value" (
  "shop_id"          UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "index_version_id" UUID NOT NULL REFERENCES "index_version"("id") ON DELETE CASCADE,
  "kind"             TEXT NOT NULL,
  "value"            TEXT NOT NULL,
  "doc_count"        INTEGER NOT NULL,
  PRIMARY KEY ("shop_id","index_version_id","kind","value")
);
CREATE INDEX IF NOT EXISTS "search_facet_value_version_idx" ON "search_facet_value"("index_version_id");
-- Serves both the facet-option read (ORDER doc_count DESC, value ASC per kind)
-- and the distinct-values read for NL context (per kind).
CREATE INDEX IF NOT EXISTS "search_facet_value_kind_idx"
  ON "search_facet_value"("shop_id","index_version_id","kind","doc_count" DESC,"value");

-- Per-version scalar summary (price range + visible doc count) for unfiltered browse.
CREATE TABLE IF NOT EXISTS "search_facet_summary" (
  "shop_id"          UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "index_version_id" UUID NOT NULL REFERENCES "index_version"("id") ON DELETE CASCADE,
  "price_min"        NUMERIC,
  "price_max"        NUMERIC,
  "doc_count"        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("shop_id","index_version_id")
);

GRANT SELECT, INSERT, UPDATE, DELETE ON "search_facet_value","search_facet_summary" TO app_runtime;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['search_facet_value','search_facet_summary'];
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
