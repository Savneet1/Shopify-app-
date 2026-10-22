-- Migration 0016 — Phase 12.1 fix batch. Applied by app_owner. Additive +
-- idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
-- re-assertable RLS + grants). Migration 0015 is NOT modified. No new Shopify
-- scope, no new extension, no new dependency, NO SECURITY DEFINER function.
--
-- Q3: per-shop HMAC PEPPER for shopper-email hashing. The email lookup hash
-- previously fell back to SHOPIFY_API_SECRET; rotating that secret would orphan
-- every stored email_hash (dedupe/suppression/redact silently break). Instead
-- each shop gets its own 32 random bytes, generated lazily under RLS the first
-- time the shop needs a hash, stored here and never returned/logged/exported.
-- It is a tenant table (RLS ENABLED + FORCED, app_runtime grants only) so a
-- shop can only ever read its own pepper, and it is erased on shop/redact +
-- uninstall. Generation is race-safe (INSERT ... ON CONFLICT DO NOTHING then
-- SELECT), so two concurrent first-use requests converge on ONE pepper.
CREATE TABLE IF NOT EXISTS "restock_hash_pepper" (
  "shop_id"    UUID PRIMARY KEY REFERENCES "shop"("id") ON DELETE CASCADE,
  "pepper"     TEXT NOT NULL,                 -- 64 hex chars (32 random bytes); never returned
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Q4(b): move the admin "send test email" cooldown off an in-memory per-process
-- Map and into the row, so it holds across instances/restarts.
ALTER TABLE "email_setting" ADD COLUMN IF NOT EXISTS "last_test_email_at" TIMESTAMPTZ;

-- Q2: the confirmation email is sent ASYNCHRONOUSLY by the worker (never inline
-- in the public request). confirm_sent_at makes that job exactly-once: it is set
-- after a successful send, and a replayed job that sees it set sends nothing.
ALTER TABLE "back_in_stock_subscription" ADD COLUMN IF NOT EXISTS "confirm_sent_at" TIMESTAMPTZ;

GRANT SELECT, INSERT, UPDATE, DELETE ON "restock_hash_pepper" TO app_runtime;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE restock_hash_pepper ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE restock_hash_pepper FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS restock_hash_pepper_tenant_isolation ON restock_hash_pepper';
  EXECUTE 'CREATE POLICY restock_hash_pepper_tenant_isolation ON restock_hash_pepper FOR ALL USING (shop_id = app_current_shop()) WITH CHECK (shop_id = app_current_shop())';
END $$;
