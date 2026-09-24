-- Migration 0002_rls_roles — multi-tenant Row-Level Security + runtime grants.
--
-- Runs as app_owner (DIRECT_DATABASE_URL). Establishes:
--   * app_current_shop()  : fail-closed reader of the app.shop_id GUC
--   * app_resolve_shop()  : SECURITY DEFINER bootstrap (domain -> shop.id)
--   * RLS policies keyed on app.shop_id for every tenant-owned table
--   * least-privilege grants for the app_runtime role
--
-- Roles (app_owner, app_runtime) are created out-of-band by an operator with
-- CREATEROLE (see prisma/roles.sql). Both are NOSUPERUSER + NOBYPASSRLS.

-- ---------------------------------------------------------------------------
-- Tenant context reader. Returns NULL when app.shop_id is unset/empty, so any
-- policy comparing to it fails closed (no rows) rather than leaking data.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_shop()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT NULLIF(current_setting('app.shop_id', true), '')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- Bootstrap resolver: authenticated shop domain -> shop.id (upsert).
-- SECURITY DEFINER so app_runtime (which cannot see other shops under RLS)
-- can resolve exactly the ONE domain the server already authenticated. This is
-- the only elevated path exposed to runtime, and it is constrained to a single
-- exact-domain lookup/insert.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_resolve_shop(p_domain text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_domain IS NULL OR length(btrim(p_domain)) = 0 THEN
    RAISE EXCEPTION 'app_resolve_shop: shop domain is required';
  END IF;

  SELECT id INTO v_id FROM shop WHERE shop_domain = p_domain;
  IF v_id IS NULL THEN
    INSERT INTO shop (shop_domain, installed_at)
      VALUES (p_domain, now())
      ON CONFLICT (shop_domain) DO UPDATE SET shop_domain = EXCLUDED.shop_domain
      RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION app_resolve_shop(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_current_shop() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Least-privilege grants for the runtime role.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT EXECUTE ON FUNCTION app_current_shop() TO app_runtime;
GRANT EXECUTE ON FUNCTION app_resolve_shop(text) TO app_runtime;

-- ---------------------------------------------------------------------------
-- RLS: tenant root (shop). ENABLED but NOT FORCED, so the SECURITY DEFINER
-- resolver (running as table owner) can perform the domain bootstrap. The
-- app_runtime role is NOT the owner, so it remains fully constrained: it can
-- only see/update its own shop row, and cannot INSERT/DELETE shop rows at all
-- (no permissive policy for those commands).
-- ---------------------------------------------------------------------------
ALTER TABLE "shop" ENABLE ROW LEVEL SECURITY;

CREATE POLICY shop_select ON "shop"
  FOR SELECT USING (id = app_current_shop());
CREATE POLICY shop_update ON "shop"
  FOR UPDATE USING (id = app_current_shop()) WITH CHECK (id = app_current_shop());

-- ---------------------------------------------------------------------------
-- RLS: tenant-owned child tables. ENABLED + FORCED (applies even to the table
-- owner) as defense in depth. One FOR ALL policy per table keyed on shop_id.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'app_setting',
    'market',
    'webhook_receipt',
    'theme_compat_report',
    'data_deletion_request',
    'billing_subscription'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (shop_id = app_current_shop()) WITH CHECK (shop_id = app_current_shop());',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- NOTE: "session" (Shopify-managed auth table) is intentionally left WITHOUT
-- RLS. It is read by session id before tenant context exists; isolation is
-- enforced by the authentication layer. See docs/SECURITY.md.
