-- Migration 0019 — Phase 13.2 locale scoping for search personalisation rows.
-- Applied by app_owner. Additive + idempotent (ADD COLUMN IF NOT EXISTS). No new
-- scope/extension/dependency, NO SECURITY DEFINER function, RLS UNCHANGED (the
-- existing per-shop FOR ALL policies already cover these columns).
--
-- An OPTIONAL `locale` column on each personalisation table. NULL = applies to
-- ALL locales (the pre-13.2 behaviour); a BCP-47 value = applies only when the
-- validated request locale matches. With no locale-specific rows (every value
-- NULL) the planner predicate `locale IS NULL OR locale = $x` selects every row,
-- so results are byte-identical to before this migration.

ALTER TABLE "search_synonym"  ADD COLUMN IF NOT EXISTS "locale" TEXT;
ALTER TABLE "search_stopword" ADD COLUMN IF NOT EXISTS "locale" TEXT;
ALTER TABLE "search_redirect" ADD COLUMN IF NOT EXISTS "locale" TEXT;

-- Partial indexes so locale-scoped lookups stay cheap WITHOUT changing the
-- existing all-locale query plans (the indexes only cover non-NULL locales).
CREATE INDEX IF NOT EXISTS "search_synonym_locale_idx"
  ON "search_synonym" ("shop_id", "locale") WHERE "locale" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "search_stopword_locale_idx"
  ON "search_stopword" ("shop_id", "locale") WHERE "locale" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "search_redirect_locale_idx"
  ON "search_redirect" ("shop_id", "locale") WHERE "locale" IS NOT NULL;

-- The redirect uniqueness was (shop_id, query_normalized); with locale scoping a
-- shop may want the SAME normalized query to redirect differently per locale.
-- Replace the unique index with one that treats NULL locale as a distinct slot.
DROP INDEX IF EXISTS "search_redirect_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "search_redirect_uniq"
  ON "search_redirect" ("shop_id", "query_normalized", COALESCE("locale", ''));

-- Same for stop-word overrides: allow the same word to be scoped per locale.
DROP INDEX IF EXISTS "search_stopword_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "search_stopword_uniq"
  ON "search_stopword" ("shop_id", "word", COALESCE("locale", ''));
