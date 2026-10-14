-- Migration 0013 — Phase 11: Analytics.
-- Applied by app_owner. Additive, idempotent-from-scratch on PostgreSQL 16.
-- No new extension, no new scope, no new npm dependency.
--
-- PRIVACY (enforced here + in app): NO IP addresses, NO user-agents, NO
-- fingerprints, NO customer identifiers are ever stored. query_norm is
-- normalized, length-bounded and PII-redacted in the app before insert.
-- occurred_at is ALWAYS the server clock (the ingestion path never trusts a
-- client timestamp).
--
-- PARTITIONING: analytics_event is RANGE-partitioned by month on occurred_at.
-- RLS is ENABLED + FORCED on the PARENT and on every partition. app_runtime is
-- granted DML on the PARENT ONLY (never on a partition), so a partition cannot
-- be read or written directly by app_runtime — only through the parent, where
-- the tenant policy applies. Partition DDL is done by owner-owned SECURITY
-- DEFINER functions that app_runtime may EXECUTE (the ingestion path ensures
-- the current month's partition exists; the maintenance tick pre-creates ahead
-- and drops partitions older than the hard retention cap). There is NO DEFAULT
-- partition (so nothing silently accumulates); an out-of-range insert with no
-- matching partition errors loudly, but the app always ensures the current
-- month first.

-- ---------------------------------------------------------------------------
-- 11.2 Per-shop analytics settings (default OFF; opt-in).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "analytics_settings" (
  "shop_id"        UUID PRIMARY KEY REFERENCES "shop"("id") ON DELETE CASCADE,
  "mode"           TEXT NOT NULL DEFAULT 'off' CHECK ("mode" IN ('off','anonymous','consented_sessions')),
  "retention_days" INT  NOT NULL DEFAULT 90 CHECK ("retention_days" >= 1 AND "retention_days" <= 395),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 11.1 Event model. Partitioned parent. Closed enums enforced by CHECK.
-- id is a surrogate for bounded batched deletes; PK must include the partition
-- key (occurred_at). FK to shop gives uninstall/shop-redact cascade for free.
-- A hard size cap on the properties jsonb is enforced by a CHECK on its text
-- length (the app also bounds it before insert).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "analytics_event" (
  "id"            BIGINT GENERATED ALWAYS AS IDENTITY,
  "shop_id"       UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "event_type"    TEXT NOT NULL CHECK ("event_type" IN (
                     'search_performed','search_zero_result','result_click','predictive_click',
                     'suggestion_click','redirect_followed','add_to_cart_from_search',
                     'recommendation_click','bundle_add_to_cart','filter_applied')),
  "occurred_at"   TIMESTAMPTZ NOT NULL,
  "session_id"    TEXT CHECK ("session_id" IS NULL OR "session_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
  "query_norm"    TEXT CHECK ("query_norm" IS NULL OR length("query_norm") <= 100),
  "query_redacted" BOOLEAN NOT NULL DEFAULT false,
  "result_count"  INT CHECK ("result_count" IS NULL OR ("result_count" >= 0 AND "result_count" <= 100000000)),
  "product_gid"   TEXT CHECK ("product_gid" IS NULL OR "product_gid" ~ '^gid://shopify/Product/[0-9]{1,20}$'),
  "position"      INT CHECK ("position" IS NULL OR ("position" >= 0 AND "position" <= 100000)),
  "experiment_id" UUID,
  "variant"       TEXT CHECK ("variant" IS NULL OR "variant" IN ('A','B','control')),
  "surface"       TEXT NOT NULL CHECK ("surface" IN ('search_page','predictive','recommendation','bundle','redirect')),
  "properties"    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (length("properties"::text) <= 2000),
  PRIMARY KEY ("occurred_at", "id")
) PARTITION BY RANGE ("occurred_at");

CREATE INDEX IF NOT EXISTS "analytics_event_shop_time_idx" ON "analytics_event" ("shop_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "analytics_event_type_idx" ON "analytics_event" ("shop_id", "event_type", "occurred_at");

-- ---------------------------------------------------------------------------
-- 11.4 Optional daily rollup for long-range trends (NO raw query text). Its own
-- retention (max 400 days) is purged on the maintenance tick.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "analytics_rollup_daily" (
  "shop_id"     UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "day"         DATE NOT NULL,
  "event_type"  TEXT NOT NULL,
  "surface"     TEXT NOT NULL,
  "event_count" BIGINT NOT NULL DEFAULT 0,
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("shop_id","day","event_type","surface")
);
CREATE INDEX IF NOT EXISTS "analytics_rollup_daily_window_idx" ON "analytics_rollup_daily" ("shop_id","day");

-- ===========================================================================
-- Grants + RLS. app_runtime gets DML on the PARENT + the two helper tables ONLY.
-- NO grants are ever issued on partitions (they are created without grants by
-- the definer function below), so app_runtime cannot touch a partition directly.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "analytics_event"        TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "analytics_settings"     TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "analytics_rollup_daily" TO app_runtime;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['analytics_event','analytics_settings','analytics_rollup_daily'];
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

-- ---------------------------------------------------------------------------
-- Partition maintenance — owner-owned SECURITY DEFINER functions. app_runtime
-- may EXECUTE them but never holds direct DDL/DML rights on a partition. Each
-- created partition gets RLS ENABLED + FORCED + the SAME tenant policy, and NO
-- grants, so direct access by app_runtime is refused while parent-routed access
-- obeys the policy.
-- ---------------------------------------------------------------------------

-- Ensure the monthly partition covering p_month exists (idempotent; a cheap
-- catalog lookup when it already does, so no lock in steady state).
CREATE OR REPLACE FUNCTION app_ensure_analytics_partition(p_month timestamptz)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_start date := date_trunc('month', (p_month AT TIME ZONE 'UTC'))::date;
  v_end   date := (date_trunc('month', (p_month AT TIME ZONE 'UTC')) + interval '1 month')::date;
  v_name  text := format('analytics_event_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  IF to_regclass(format('public.%I', v_name)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.analytics_event FOR VALUES FROM (%L) TO (%L);',
      v_name, v_start::text, v_end::text
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', v_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', v_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', v_name || '_tenant_isolation', v_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING (shop_id = app_current_shop()) WITH CHECK (shop_id = app_current_shop());',
      v_name || '_tenant_isolation', v_name
    );
    -- Deliberately NO GRANT on the partition: app_runtime reaches rows only via
    -- the parent table (where it has DML + the policy applies).
  END IF;
  RETURN v_name;
END;
$$;

-- Drop every analytics partition whose entire range is strictly before
-- p_cutoff's month. Returns the number of partitions dropped. Used by the tick
-- with the HARD retention cap, never a per-shop value (partitions are shared by
-- all shops; per-shop retention is enforced by the row purge + query window).
CREATE OR REPLACE FUNCTION app_drop_analytics_partitions_before(p_cutoff timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cut_month date := date_trunc('month', (p_cutoff AT TIME ZONE 'UTC'))::date;
  r record;
  v_dropped int := 0;
BEGIN
  FOR r IN
    SELECT c.relname,
           regexp_replace(c.relname, '^analytics_event_', '') AS ym
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'analytics_event'
  LOOP
    -- partition covers month to_date(ym,'YYYY_MM'); drop if its upper bound
    -- (first of the next month) is <= the cutoff month.
    IF (to_date(r.ym, 'YYYY_MM') + interval '1 month')::date <= v_cut_month THEN
      EXECUTE format('DROP TABLE IF EXISTS public.%I;', r.relname);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;
  RETURN v_dropped;
END;
$$;

-- List current analytics partitions (name + month) — read-only, for the
-- maintenance tick and tests. STABLE, definer so app_runtime can introspect.
CREATE OR REPLACE FUNCTION app_list_analytics_partitions()
RETURNS TABLE (partition_name text, month_start date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.relname,
         to_date(regexp_replace(c.relname, '^analytics_event_', ''), 'YYYY_MM')
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE p.relname = 'analytics_event'
  ORDER BY 2;
$$;

REVOKE ALL ON FUNCTION app_ensure_analytics_partition(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_drop_analytics_partitions_before(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_list_analytics_partitions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ensure_analytics_partition(timestamptz) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_drop_analytics_partitions_before(timestamptz) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_list_analytics_partitions() TO app_runtime;

-- Bootstrap: ensure a window of partitions around the migration date exists so
-- inserts work immediately after deploy (previous, current, next 2 months).
SELECT app_ensure_analytics_partition(now() - interval '1 month');
SELECT app_ensure_analytics_partition(now());
SELECT app_ensure_analytics_partition(now() + interval '1 month');
SELECT app_ensure_analytics_partition(now() + interval '2 month');
