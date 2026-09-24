-- Migration 0005 — Phase 2.1 preflight (G8 scheduled reconciliation support).

-- Marker for the last successful full sync, updated inside the shop's tenant
-- context. Enables enumerating shops that need a periodic reconciliation.
ALTER TABLE "shop" ADD COLUMN IF NOT EXISTS "last_full_sync_at" TIMESTAMP(3);

-- Cross-shop enumeration is blocked by RLS for app_runtime. This SECURITY
-- DEFINER function (owned by app_owner; shop is RLS-ENABLED but NOT FORCED, so
-- the owner sees all shops) returns the ids of INSTALLED shops whose last full
-- sync is older than the given interval (or never). It exposes only shop ids —
-- no other tenant data — and is the only elevated read the scheduler uses.
CREATE OR REPLACE FUNCTION app_shops_needing_full_sync(p_interval interval)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id FROM shop s
  WHERE s.uninstalled_at IS NULL
    AND (s.last_full_sync_at IS NULL OR s.last_full_sync_at < now() - p_interval)
$$;

REVOKE ALL ON FUNCTION app_shops_needing_full_sync(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_shops_needing_full_sync(interval) TO app_runtime;
