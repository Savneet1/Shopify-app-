-- Migration 0025 — Phase 14c W1: schema support for DELTA maintenance of the
-- per-version precomputed structures (so a product update no longer re-aggregates
-- the whole visible catalog). Additive + idempotent. No new scope/dependency/
-- extension, NO SECURITY DEFINER function. RLS on the existing tables is unchanged.
--
--  * search_suggest_term gains a doc_count refcount (how many visible docs
--    contribute the term) so terms can be added/removed by +/-1 and deleted when
--    the count reaches 0. Reads do not select it, so suggestions stay byte-identical.
--  * search_facet_summary gains price_dirty: the price range (min/max) is the one
--    value that cannot be delta-maintained exactly on removals (losing the extreme
--    needs a rescan). When a write could drop an extreme we set price_dirty; the
--    reader then falls back to the live min/max (always exact) until the reconcile
--    job recomputes and clears it.
--  * Partial indexes on the "<= 0" rows make the post-delta cleanup DELETE touch
--    only the handful of rows that actually reached zero (O(changed), not O(catalog)).

ALTER TABLE "search_suggest_term"  ADD COLUMN IF NOT EXISTS "doc_count" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "search_facet_summary" ADD COLUMN IF NOT EXISTS "price_dirty" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "search_vocabulary_zero_idx"
  ON "search_vocabulary" ("shop_id","index_version_id") WHERE "doc_freq" <= 0;
CREATE INDEX IF NOT EXISTS "search_facet_value_zero_idx"
  ON "search_facet_value" ("shop_id","index_version_id") WHERE "doc_count" <= 0;
CREATE INDEX IF NOT EXISTS "search_suggest_term_zero_idx"
  ON "search_suggest_term" ("shop_id","index_version_id") WHERE "doc_count" <= 0;
