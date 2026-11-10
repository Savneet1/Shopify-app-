-- Migration 0023 — Phase 14b P5: index support for generating recommendation
-- candidates via index lookups instead of scanning every visible doc. Additive
-- + idempotent. No new scope/dependency/extension, NO SECURITY DEFINER function
-- (the helper below is a plain IMMUTABLE function).
--
-- Case-insensitive tag overlap is part of the recommendation qualification gate
-- (tags are compared with lower() on both sides). To drive that from an index we
-- need a GIN index over the LOWERCASED tag array; that needs an IMMUTABLE helper
-- (PostgreSQL has no built-in array-lowercasing). The other candidate predicates
-- already have indexes: product_type (psd_ptype_btree), vendor (psd_vendor_btree),
-- title trigram (psd_title_trgm), collections (product_collection / collection),
-- raw tags (psd_tags_gin).

CREATE OR REPLACE FUNCTION immutable_lower_text_array(text[])
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT array_agg(lower(x)) FROM unnest($1) AS x $$;

CREATE INDEX IF NOT EXISTS "psd_tags_lower_gin"
  ON "product_search_doc" USING gin (immutable_lower_text_array("tags"));
