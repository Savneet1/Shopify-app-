-- Migration 0014 — Phase 11.1: SECURITY DEFINER partition-function hardening.
-- Applied by app_owner. Additive + idempotent (CREATE OR REPLACE only; no table
-- or data change), so already-applied databases pick up the fixes on deploy.
-- Migration 0013 is NOT modified.
--
-- ============================================================================
-- THREAT MODEL (why this migration exists)
-- ----------------------------------------------------------------------------
-- app_runtime is the role EVERY request handler and the worker run as. It is
-- NOSUPERUSER / NOBYPASSRLS and reaches tenant rows only through RLS policies
-- keyed on app_current_shop(). But a SECURITY DEFINER function runs with the
-- OWNER's privileges and BYPASSES RLS for whatever it does internally, so a
-- definer function that app_runtime may EXECUTE must NEVER let a caller — in any
-- tenant context, with any argument — read or destroy another tenant's data.
--
-- As shipped in 0013, the two partition-maintenance definer functions trusted
-- their timestamptz argument:
--   * app_drop_analytics_partitions_before('2100-01-01') dropped EVERY monthly
--     partition of analytics_event — destroying ALL shops' events (cross-tenant
--     data destruction), callable by app_runtime from any tenant context.
--   * app_ensure_analytics_partition(<any month>) created unbounded partitions
--     (year 9999, year 1900, hundreds of future months) — catalog bloat / DDL
--     abuse.
-- The comments claimed the tick "uses the hard retention cap" but nothing in the
-- function enforced it. This migration enforces both bounds INSIDE the functions
-- (defence in depth; callers are not trusted). SECURITY DEFINER + SET search_path
-- are kept; EXECUTE stays granted to app_runtime only for ensure/drop/list.
-- ============================================================================

-- Single source of truth for the hard partition-retention cap (days). The app
-- constant PARTITION_RETENTION_DAYS (app/lib/analytics/settings.ts) MUST equal
-- this; a test (phase11_1-definer) reads both and asserts they agree. IMMUTABLE
-- so it can be used in the drop function's floor computation.
CREATE OR REPLACE FUNCTION app_analytics_hard_retention_days()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 395 $$;

-- ----------------------------------------------------------------------------
-- app_drop_analytics_partitions_before — HARD-FLOORED. Whatever month the caller
-- requests, the effective cutoff is clamped to no newer than
--   hard_floor_month = date_trunc('month', nowUTC - <hard retention> days).
-- So it is IMPOSSIBLE, with any argument, to drop a partition that could hold
-- data newer than the hard retention cap. Normal tick use (cutoff = now - 395d)
-- is unchanged: LEAST(requested, floor) = floor. Returns the number dropped.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_drop_analytics_partitions_before(p_cutoff timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hard_floor_month date :=
    date_trunc('month', (now() AT TIME ZONE 'UTC')
                        - make_interval(days => app_analytics_hard_retention_days()))::date;
  v_requested_month  date := date_trunc('month', (p_cutoff AT TIME ZONE 'UTC'))::date;
  -- Clamp: never newer than the hard floor, whatever the caller passed.
  v_cut_month        date := LEAST(v_requested_month, v_hard_floor_month);
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
    -- drop only if the partition's upper bound (first of the next month) is at
    -- or before the (clamped) cutoff month.
    IF (to_date(r.ym, 'YYYY_MM') + interval '1 month')::date <= v_cut_month THEN
      EXECUTE format('DROP TABLE IF EXISTS public.%I;', r.relname);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;
  RETURN v_dropped;
END;
$$;

-- ----------------------------------------------------------------------------
-- app_ensure_analytics_partition — RANGE-BOUNDED. Only months within
--   [current month - 14 months, current month + 3 months]  (UTC)
-- may be created; anything outside raises 22023 (invalid_parameter_value) and
-- creates nothing. The ingestion path (now) and the tick (current + next 2
-- months) stay within range. Each created partition still gets RLS
-- ENABLED+FORCED + the tenant policy and NO grant (parent-routed access only).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_ensure_analytics_partition(p_month timestamptz)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req_month date := date_trunc('month', (p_month AT TIME ZONE 'UTC'))::date;
  v_cur_month date := date_trunc('month', (now()   AT TIME ZONE 'UTC'))::date;
  v_lo        date := (v_cur_month - interval '14 months')::date;
  v_hi        date := (v_cur_month + interval '3 months')::date;
  v_start date;
  v_end   date;
  v_name  text;
BEGIN
  IF v_req_month < v_lo OR v_req_month > v_hi THEN
    RAISE EXCEPTION
      'app_ensure_analytics_partition: month % is outside the allowed range [%, %]',
      v_req_month, v_lo, v_hi
      USING ERRCODE = '22023';
  END IF;
  v_start := v_req_month;
  v_end   := (v_req_month + interval '1 month')::date;
  v_name  := format('analytics_event_%s', to_char(v_start, 'YYYY_MM'));
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
    -- Deliberately NO GRANT on the partition (parent-routed access only).
  END IF;
  RETURN v_name;
END;
$$;

-- Lock down EXECUTE (unchanged intent; re-asserted idempotently).
REVOKE ALL ON FUNCTION app_analytics_hard_retention_days()            FROM PUBLIC;
REVOKE ALL ON FUNCTION app_drop_analytics_partitions_before(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_ensure_analytics_partition(timestamptz)    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_analytics_hard_retention_days()            TO app_runtime;
GRANT EXECUTE ON FUNCTION app_drop_analytics_partitions_before(timestamptz) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_ensure_analytics_partition(timestamptz)    TO app_runtime;

-- Re-ensure the standard partition window (all within the new allowed range).
SELECT app_ensure_analytics_partition(now() - interval '1 month');
SELECT app_ensure_analytics_partition(now());
SELECT app_ensure_analytics_partition(now() + interval '1 month');
SELECT app_ensure_analytics_partition(now() + interval '2 month');
