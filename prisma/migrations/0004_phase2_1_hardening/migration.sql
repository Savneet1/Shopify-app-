-- Migration 0004 — Phase 2.1 hardening.
-- Adds: index build snapshot boundary, single-running-sync guard, sync stats.

-- Snapshot boundary: the moment buildDocs read the catalog, so activation can
-- catch up any product changed/deleted after the snapshot (build/swap race fix).
ALTER TABLE "index_version" ADD COLUMN IF NOT EXISTS "snapshot_at" TIMESTAMP(3);

-- Inventory AVAILABILITY signals readable with read_products only (object-level
-- scope). Numeric stock (inventoryQuantity) is NOT synced: it needs
-- read_inventory (see docs/PHASE2.md REQUIRES VERIFICATION).
ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "total_inventory"  INTEGER;
ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "tracks_inventory" BOOLEAN;
ALTER TABLE "variant"  ADD COLUMN IF NOT EXISTS "available_for_sale" BOOLEAN;

-- Sync run: reconciliation stats + a human-readable warning (large-deletion
-- safety check), and a true product count from the parsed snapshot.
ALTER TABLE "sync_run" ADD COLUMN IF NOT EXISTS "stats" JSONB;
ALTER TABLE "sync_run" ADD COLUMN IF NOT EXISTS "warning" TEXT;
ALTER TABLE "sync_run" ADD COLUMN IF NOT EXISTS "product_count" INTEGER;

-- Authoritative per-shop serialization of full syncs: at most one running
-- sync_run per shop. A second concurrent full sync fails to start (unique
-- violation) and is skipped. Stale 'running' rows are recovered before start.
CREATE UNIQUE INDEX IF NOT EXISTS "sync_run_one_running_per_shop"
  ON "sync_run" ("shop_id") WHERE "status" = 'running';
