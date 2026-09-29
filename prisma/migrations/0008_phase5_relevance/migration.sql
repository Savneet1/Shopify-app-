-- Migration 0008 — Phase 5: search relevance (typo tolerance, synonyms,
-- stop words, redirects). Applied by app_owner. Additive, idempotent-from-scratch.
--
-- No new extension: pg_trgm (installed in 0006) provides the trigram GIN index
-- used for fuzzy candidate generation. Damerau-Levenshtein itself is computed in
-- TypeScript (app/lib/search/damerau.ts) — see docs/PHASE5.md for why.
-- No new Shopify scope. All four tables are tenant-scoped (shop_id) with RLS
-- ENABLED + FORCED and are accessed only as app_runtime.

-- ---------------------------------------------------------------------------
-- Per-shop, per-index-version vocabulary (surface terms + document frequency),
-- derived from product_search_doc.search_text by rebuildVocabulary(). Keyed by
-- index_version so it follows the versioned lifecycle and the atomic swap; only
-- the ACTIVE version's vocabulary is read at query time. ON DELETE CASCADE keeps
-- it in step when a version is pruned/rolled back away.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "search_vocabulary" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"          UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "index_version_id" UUID NOT NULL REFERENCES "index_version"("id") ON DELETE CASCADE,
  "term"             TEXT NOT NULL,
  "doc_freq"         INTEGER NOT NULL DEFAULT 0,
  -- numeric/code-like terms are excluded from the fuzzy candidate pool.
  "is_numeric"       BOOLEAN NOT NULL DEFAULT false,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "search_vocabulary_uniq" ON "search_vocabulary"("shop_id","index_version_id","term");
CREATE INDEX IF NOT EXISTS "search_vocabulary_term_trgm" ON "search_vocabulary" USING gin ("term" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "search_vocabulary_version_idx" ON "search_vocabulary"("index_version_id");

-- ---------------------------------------------------------------------------
-- Per-shop synonyms, applied at QUERY time (no reindex on change).
--   kind='two_way' : `terms` is an equivalence group (a <-> b <-> c); from_term NULL.
--   kind='one_way' : `from_term` -> `terms` (targets). Terms may be multi-word.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "search_synonym" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"    UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "kind"       TEXT NOT NULL CHECK ("kind" IN ('one_way','two_way')),
  "from_term"  TEXT,
  "terms"      TEXT[] NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "search_synonym_shop_idx" ON "search_synonym"("shop_id");

-- ---------------------------------------------------------------------------
-- Per-shop stop-word overrides on top of a default list (in code).
--   mode='add'    : treat this word as a stop word for this shop.
--   mode='remove' : do NOT treat this default stop word as a stop word.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "search_stopword" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"    UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "word"       TEXT NOT NULL,
  "mode"       TEXT NOT NULL CHECK ("mode" IN ('add','remove')),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "search_stopword_uniq" ON "search_stopword"("shop_id","word");

-- ---------------------------------------------------------------------------
-- Per-shop query -> destination redirects, matched on the NORMALIZED query
-- (exact match only). Destination validated to a same-shop relative path or the
-- shop's own domain in application code (open-redirect protection).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "search_redirect" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"          UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "query_normalized" TEXT NOT NULL,
  "destination"      TEXT NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "search_redirect_uniq" ON "search_redirect"("shop_id","query_normalized");

-- ===========================================================================
-- Grants + RLS (ENABLE + FORCE) for the Phase 5 tenant tables. Identical
-- pattern to Phase 2 (migration 0003). app_runtime gains NO new privilege
-- beyond row access to these tables under the tenant policy.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "search_vocabulary","search_synonym","search_stopword","search_redirect"
TO app_runtime;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'search_vocabulary','search_synonym','search_stopword','search_redirect'
  ];
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
