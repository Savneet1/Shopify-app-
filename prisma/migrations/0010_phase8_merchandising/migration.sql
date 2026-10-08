-- Migration 0010 — Phase 8: merchandising rules, banners, and A/B testing.
-- Applied by app_owner. Additive, idempotent-from-scratch on PostgreSQL 16.
-- No new extension, no new scope. Five new tenant tables (RLS enabled+forced),
-- grants to app_runtime only. DROP POLICY IF EXISTS before CREATE POLICY.

-- ---------------------------------------------------------------------------
-- A/B experiments (created FIRST so merch_rule can reference it). A variant is
-- a rule set (rules tagged variant 'A'/'B') plus an optional bounded ranking
-- weight override. Only aggregate exposure/click counts are kept (ab_exposure);
-- there are no per-user rows, no PII, no logged queries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ab_experiment" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"            UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "name"               TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','running','stopped')),
  "split_pct"          INT  NOT NULL DEFAULT 50 CHECK ("split_pct" >= 0 AND "split_pct" <= 100),
  "weight_override_a"  INT  CHECK ("weight_override_a" IS NULL OR ("weight_override_a" >= -90 AND "weight_override_a" <= 90)),
  "weight_override_b"  INT  CHECK ("weight_override_b" IS NULL OR ("weight_override_b" >= -90 AND "weight_override_b" <= 90)),
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ab_experiment_shop_idx" ON "ab_experiment"("shop_id","status");

-- ---------------------------------------------------------------------------
-- Merchandising rules. action ∈ pin|boost|demote|hide. scope ∈ query_exact |
-- query_contains | collection | global. position (pin), weight (boost/demote
-- magnitude, bounded 1..90) kept small so a rule can only ever reorder WITHIN a
-- match class (class steps are 100 apart — see app/lib/search/ranking.ts). A
-- rule may belong to an experiment variant (null = always-on).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "merch_rule" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"       UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "action"        TEXT NOT NULL CHECK ("action" IN ('pin','boost','demote','hide')),
  "scope_type"    TEXT NOT NULL CHECK ("scope_type" IN ('query_exact','query_contains','collection','global')),
  "scope_value"   TEXT,
  "priority"      INT  NOT NULL DEFAULT 100,
  "position"      INT  CHECK ("position" IS NULL OR ("position" >= 1 AND "position" <= 1000)),
  "weight"        INT  CHECK ("weight" IS NULL OR ("weight" >= 1 AND "weight" <= 90)),
  "starts_at"     TIMESTAMPTZ,
  "ends_at"       TIMESTAMPTZ,
  "timezone"      TEXT,
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "experiment_id" UUID REFERENCES "ab_experiment"("id") ON DELETE SET NULL,
  "variant"       TEXT CHECK ("variant" IS NULL OR "variant" IN ('A','B')),
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "merch_rule_shop_idx" ON "merch_rule"("shop_id","enabled","scope_type");
CREATE INDEX IF NOT EXISTS "merch_rule_exp_idx" ON "merch_rule"("shop_id","experiment_id");

-- Targets of a rule: specific products (by gid or handle), resolved to the
-- active-version product_search_doc at query time.
CREATE TABLE IF NOT EXISTS "merch_rule_target" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"      UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "rule_id"      UUID NOT NULL REFERENCES "merch_rule"("id") ON DELETE CASCADE,
  "target_kind"  TEXT NOT NULL CHECK ("target_kind" IN ('gid','handle')),
  "target_value" TEXT NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "merch_rule_target_rule_idx" ON "merch_rule_target"("shop_id","rule_id");

-- ---------------------------------------------------------------------------
-- Banners / content blocks (per query or collection, scheduled). image_url and
-- link_path are validated in app code (Phase 7.1 allowlist model: https CDN /
-- shop host for images; same-site path for links); text length bounded.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "merch_banner" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"     UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "scope_type"  TEXT NOT NULL CHECK ("scope_type" IN ('query_exact','query_contains','collection')),
  "scope_value" TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "body"        TEXT NOT NULL DEFAULT '',
  "image_url"   TEXT,
  "link_path"   TEXT,
  "priority"    INT  NOT NULL DEFAULT 100,
  "starts_at"   TIMESTAMPTZ,
  "ends_at"     TIMESTAMPTZ,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "merch_banner_shop_idx" ON "merch_banner"("shop_id","scope_type","scope_value");

-- ---------------------------------------------------------------------------
-- A/B aggregate exposure/click counters (one row per experiment+variant). No
-- per-user rows. variant ∈ control|A|B.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ab_exposure" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"       UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "experiment_id" UUID NOT NULL REFERENCES "ab_experiment"("id") ON DELETE CASCADE,
  "variant"       TEXT NOT NULL CHECK ("variant" IN ('control','A','B')),
  "exposures"     BIGINT NOT NULL DEFAULT 0,
  "clicks"        BIGINT NOT NULL DEFAULT 0,
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ab_exposure_uniq" ON "ab_exposure"("shop_id","experiment_id","variant");

-- ===========================================================================
-- Grants + RLS (ENABLE + FORCE) for all Phase 8 tenant tables.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "ab_experiment"     TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "merch_rule"        TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "merch_rule_target" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "merch_banner"      TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ab_exposure"       TO app_runtime;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['ab_experiment','merch_rule','merch_rule_target','merch_banner','ab_exposure'];
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
