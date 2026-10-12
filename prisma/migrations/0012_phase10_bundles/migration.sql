-- Migration 0012 — Phase 10: Bundles.
-- Applied by app_owner. Additive, idempotent-from-scratch on PostgreSQL 16.
-- No new extension, no new scope, no new npm dependency. Three new tenant tables
-- (RLS enabled+forced), grants to app_runtime only. DROP POLICY IF EXISTS before
-- CREATE POLICY.
--
-- Bundles are merchant-curated product sets. docInsertSql is NOT changed — the
-- bundle engine reads the active index version's visible docs (published+ACTIVE)
-- and joins the catalog `variant` table for per-variant price/availability.
--
-- PRICING HONESTY: a bundle may RECORD an intended discount
-- (intended_discount_*), but it is never applied and never shown to shoppers —
-- this app has no write_discounts scope and deploys no Shopify Function. See
-- docs/PHASE10.md.

-- ---------------------------------------------------------------------------
-- 10.1 Bundle definition. bundle_type ∈ fixed | mix_and_match. For mix_and_match
-- the slots are the M candidate products and the shopper picks mix_pick_count
-- (N) of the available ones. Optional schedule (UTC + IANA tz for display).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bundle" (
  "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"                 UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "name"                    TEXT NOT NULL,
  "description"             TEXT NOT NULL DEFAULT '',
  "bundle_type"             TEXT NOT NULL CHECK ("bundle_type" IN ('fixed','mix_and_match')),
  "status"                  TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','active','archived')),
  "mix_pick_count"          INT  CHECK ("mix_pick_count" IS NULL OR ("mix_pick_count" >= 1 AND "mix_pick_count" <= 10)),
  "placement"               TEXT NOT NULL DEFAULT 'product',
  "position"                INT  NOT NULL DEFAULT 100,
  "starts_at"               TIMESTAMPTZ,
  "ends_at"                 TIMESTAMPTZ,
  "timezone"                TEXT,
  -- Recorded-but-NEVER-applied intended discount (reference only; see docs).
  "intended_discount_type"  TEXT CHECK ("intended_discount_type" IS NULL OR "intended_discount_type" IN ('percent','fixed_amount','fixed_price')),
  "intended_discount_value" NUMERIC(12,2) CHECK ("intended_discount_value" IS NULL OR "intended_discount_value" >= 0),
  "intended_discount_note"  TEXT NOT NULL DEFAULT '',
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "bundle_shop_idx" ON "bundle"("shop_id","status");

-- ---------------------------------------------------------------------------
-- Bundle slots. A slot references a product by gid or handle, with either a
-- fixed variant or "customer picks variant", and a quantity. For a fixed bundle
-- every slot is required; for mix_and_match the slots are the candidate list.
-- Products are resolved to the active version's visible docs at query time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bundle_slot" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"           UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "bundle_id"         UUID NOT NULL REFERENCES "bundle"("id") ON DELETE CASCADE,
  "position"          INT  NOT NULL DEFAULT 1,
  "product_ref_kind"  TEXT NOT NULL CHECK ("product_ref_kind" IN ('gid','handle')),
  "product_ref_value" TEXT NOT NULL,
  "variant_mode"      TEXT NOT NULL CHECK ("variant_mode" IN ('fixed','customer_picks')),
  "variant_gid"       TEXT,
  "quantity"          INT  NOT NULL DEFAULT 1 CHECK ("quantity" >= 1 AND "quantity" <= 10),
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "bundle_slot_bundle_idx" ON "bundle_slot"("shop_id","bundle_id","position");

-- ---------------------------------------------------------------------------
-- 10.6 Aggregate bundle metrics, per UTC day. views + add-to-cart clicks ONLY.
-- Fed by a public, inflatable beacon → advisory (Phase 11 analytics supersedes).
-- NO visitor id, NO IP, NO per-user row, NO query text. Windowed + purged by the
-- maintenance tick (see app/lib/recommend/signals.ts retention path reuse).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bundle_signal_daily" (
  "shop_id"            UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "bundle_id"          UUID NOT NULL REFERENCES "bundle"("id") ON DELETE CASCADE,
  "day"                DATE NOT NULL,
  "views"              BIGINT NOT NULL DEFAULT 0,
  "add_to_cart_clicks" BIGINT NOT NULL DEFAULT 0,
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("shop_id", "bundle_id", "day")
);
CREATE INDEX IF NOT EXISTS "bundle_signal_daily_window_idx" ON "bundle_signal_daily"("shop_id","day");

-- ===========================================================================
-- Grants + RLS (ENABLE + FORCE) for all Phase 10 tenant tables.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "bundle"              TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "bundle_slot"         TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "bundle_signal_daily" TO app_runtime;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['bundle','bundle_slot','bundle_signal_daily'];
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
