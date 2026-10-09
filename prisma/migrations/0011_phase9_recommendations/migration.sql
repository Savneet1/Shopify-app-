-- Migration 0011 — Phase 9: Recommendations.
-- Applied by app_owner. Additive, idempotent-from-scratch on PostgreSQL 16.
-- No new extension (pg_trgm/unaccent already installed in 0006), no new scope,
-- no new npm dependency. Four new tenant tables (RLS enabled+forced), grants to
-- app_runtime only. DROP POLICY IF EXISTS before CREATE POLICY.
--
-- PRIVACY: product_signal_daily holds ONLY aggregate per-product daily counters
-- (views/clicks). There is NO visitor id, NO IP, NO per-user row, NO query text.
-- The beacon that feeds it is public and inflatable — the counts are advisory
-- (a trending heuristic), never authoritative. See docs/PHASE9.md.

-- ---------------------------------------------------------------------------
-- 9.2 Trending signals — aggregate per product, per UTC day. The product_id is
-- an INTERNAL product id resolved server-side from a validated client ref
-- (handle/gid) against the active index version; junk refs are dropped before
-- any write, so only real products of this shop are ever counted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "product_signal_daily" (
  "shop_id"    UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "product_id" UUID NOT NULL REFERENCES "product"("id") ON DELETE CASCADE,
  "day"        DATE NOT NULL,
  "views"      BIGINT NOT NULL DEFAULT 0,
  "clicks"     BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("shop_id", "product_id", "day")
);
CREATE INDEX IF NOT EXISTS "product_signal_daily_window_idx"
  ON "product_signal_daily"("shop_id","day");

-- ---------------------------------------------------------------------------
-- 9.3 Frequently-bought-together co-occurrence (deterministic builder over an
-- abstract BasketSource — NO real Shopify orders source is wired in Phase 9).
-- Canonical unordered pairs are stored once with product_a <= product_b:
--   * a < b  rows hold the co-occurrence count of the pair;
--   * a = b  rows hold the single-item SUPPORT (number of baskets containing it)
--            so confidence = pair_count(a,b) / support(seed) needs no join table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "product_cooccurrence" (
  "shop_id"      UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "product_a"    UUID NOT NULL REFERENCES "product"("id") ON DELETE CASCADE,
  "product_b"    UUID NOT NULL REFERENCES "product"("id") ON DELETE CASCADE,
  "pair_count"   BIGINT NOT NULL DEFAULT 0,
  "last_updated" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("shop_id", "product_a", "product_b"),
  CONSTRAINT "product_cooccurrence_canonical" CHECK ("product_a" <= "product_b")
);
CREATE INDEX IF NOT EXISTS "product_cooccurrence_a_idx"
  ON "product_cooccurrence"("shop_id","product_a","pair_count");
CREATE INDEX IF NOT EXISTS "product_cooccurrence_b_idx"
  ON "product_cooccurrence"("shop_id","product_b","pair_count");

-- Build bookkeeping / the basket count N used for the optional lift ranking. One
-- row per shop; rewritten atomically by an idempotent rebuild.
CREATE TABLE IF NOT EXISTS "product_cooccurrence_build" (
  "shop_id"      UUID PRIMARY KEY REFERENCES "shop"("id") ON DELETE CASCADE,
  "basket_count" BIGINT NOT NULL DEFAULT 0,
  "source"       TEXT NOT NULL DEFAULT 'none',
  "built_at"     TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- 9.6 Recommendation settings — one row per shop (enable flags per type, OOS
-- policy, per-vendor diversification cap, FBT fallback, trending half-life).
-- fbt_enabled defaults FALSE: no real co-occurrence data source is approved in
-- Phase 9 (real FBT needs read_orders — Requires Verification; see docs).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "recommendation_settings" (
  "shop_id"                 UUID PRIMARY KEY REFERENCES "shop"("id") ON DELETE CASCADE,
  "similar_enabled"         BOOLEAN NOT NULL DEFAULT true,
  "related_enabled"         BOOLEAN NOT NULL DEFAULT true,
  "trending_enabled"        BOOLEAN NOT NULL DEFAULT true,
  "fbt_enabled"             BOOLEAN NOT NULL DEFAULT false,
  "recent_enabled"          BOOLEAN NOT NULL DEFAULT true,
  "include_out_of_stock"    BOOLEAN NOT NULL DEFAULT false,
  "diversify_per_vendor"    INT NOT NULL DEFAULT 0 CHECK ("diversify_per_vendor" >= 0 AND "diversify_per_vendor" <= 24),
  "fbt_fallback_related"    BOOLEAN NOT NULL DEFAULT true,
  "trending_half_life_days" INT NOT NULL DEFAULT 7 CHECK ("trending_half_life_days" >= 1 AND "trending_half_life_days" <= 90),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- Grants + RLS (ENABLE + FORCE) for all Phase 9 tenant tables. app_runtime is
-- NOSUPERUSER/NOBYPASSRLS and never the owner, so these policies fully bound it.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_signal_daily"        TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_cooccurrence"        TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_cooccurrence_build"  TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "recommendation_settings"     TO app_runtime;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'product_signal_daily',
    'product_cooccurrence',
    'product_cooccurrence_build',
    'recommendation_settings'
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
