-- Migration 0024 — Phase 14b P2: per-index-version precomputed suggestion terms,
-- so catalog suggestions do an index-driven prefix lookup over a small terms
-- table instead of scanning every visible doc (and unnesting collections) per
-- keystroke. Additive + idempotent. No new scope/dependency/extension, NO
-- SECURITY DEFINER function.
--
-- Rebuilt from the version's VISIBLE docs (published + ACTIVE) by
-- rebuildVocabulary — the SAME choke point as search_vocabulary — so it always
-- matches the version's docs and follows swap / rollback (keyed by
-- index_version_id, ON DELETE CASCADE for retention). The collection titles are
-- the version SNAPSHOT (doc->'collections'), so suggestions stay version-
-- consistent even if a collection is renamed after the build.
--
-- Used ONLY when a request has no merchandising hide ids and combined mode is
-- show_all (no per-request, product-level exclusion); otherwise suggestions fall
-- back to the live per-doc scan (which can apply those dynamic exclusions). Both
-- paths are byte-identical.

CREATE TABLE IF NOT EXISTS "search_suggest_term" (
  "shop_id"          UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "index_version_id" UUID NOT NULL REFERENCES "index_version"("id") ON DELETE CASCADE,
  "type"             TEXT NOT NULL,   -- 'title' | 'vendor' | 'productType' | 'collection'
  "text"             TEXT NOT NULL,
  PRIMARY KEY ("shop_id","index_version_id","type","text")
);
CREATE INDEX IF NOT EXISTS "search_suggest_term_version_idx" ON "search_suggest_term"("index_version_id");
-- Accent-folded, lower-cased trigram index for the prefix LIKE (pg_trgm serves
-- a parameterised LIKE for prefixes of >= 3 chars; shorter prefixes scan the
-- small per-version terms table, far cheaper than scanning all docs).
CREATE INDEX IF NOT EXISTS "search_suggest_term_trgm"
  ON "search_suggest_term" USING gin (immutable_unaccent(lower("text")) gin_trgm_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON "search_suggest_term" TO app_runtime;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE search_suggest_term ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE search_suggest_term FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS search_suggest_term_tenant_isolation ON search_suggest_term';
  EXECUTE 'CREATE POLICY search_suggest_term_tenant_isolation ON search_suggest_term FOR ALL USING (shop_id = app_current_shop()) WITH CHECK (shop_id = app_current_shop())';
END $$;
