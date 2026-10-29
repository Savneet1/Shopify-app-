-- Migration 0018 — Phase 13.5 Combined Listings (READ-ONLY, read_products only).
-- Applied by app_owner. Additive + idempotent (ADD COLUMN IF NOT EXISTS). No new
-- scope/extension/dependency, NO SECURITY DEFINER function, no RLS change.
--
-- Verified in the Admin GraphQL schema (pinned API 2026-07): Product.combinedListingRole
-- (enum CombinedListingsRole = CHILD | PARENT; null = not part of a combined
-- listing) and Product.combinedListing { parentProduct, combinedListingChildren }
-- are READABLE with read_products; only combinedListingUpdate needs write_products.
--
-- We store per product its role and, for a CHILD, its parent's gid. A PARENT's
-- child count + aggregate price range is DERIVED at doc-build time from the child
-- rows (which carry combined_parent_gid), so no second connection is synced.

ALTER TABLE "product"
  ADD COLUMN IF NOT EXISTS "combined_role" TEXT
    CHECK ("combined_role" IS NULL OR "combined_role" IN ('PARENT','CHILD'));
ALTER TABLE "product"
  ADD COLUMN IF NOT EXISTS "combined_parent_gid" TEXT;

-- Find a parent's children quickly, and filter by role in the planner.
CREATE INDEX IF NOT EXISTS "product_combined_parent_idx"
  ON "product" ("shop_id", "combined_parent_gid") WHERE "combined_parent_gid" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "product_combined_role_idx"
  ON "product" ("shop_id", "combined_role") WHERE "combined_role" IS NOT NULL;

-- The role is denormalised onto the search doc so the one planner can apply a
-- HARD WHERE (hide_children / hide_parents) like the Phase 8 hide mechanism.
-- NULL for every product when a shop has no combined listings → byte-identical.
ALTER TABLE "product_search_doc"
  ADD COLUMN IF NOT EXISTS "combined_role" TEXT;
