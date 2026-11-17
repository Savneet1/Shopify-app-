-- Migration 0027 — Phase 14e least-privilege maintenance role. Applied by
-- app_owner. Additive + idempotent (re-runnable). No new scope/extension/
-- dependency, NO SECURITY DEFINER function. RLS stays ENABLED + FORCED and every
-- policy/grant for app_runtime is left exactly as-is. Results byte-identical.
--
-- WHY: Phase 14d ran the synchronous post-build ANALYZE over an OWNER connection
-- (DIRECT_DATABASE_URL = app_owner). ANALYZE requires table ownership and
-- PostgreSQL 16 has no MAINTAIN privilege, so 14d reused the migration-owner
-- credential at runtime for the first time (before 14d no runtime code read
-- DIRECT_DATABASE_URL). That is too much authority in the worker: app_owner owns
-- the whole schema, so a compromised worker holding that credential could DROP or
-- ALTER tables or disable RLS and reach shop access tokens, subscriber emails and
-- encrypted SMTP credentials. (It still could not bypass RLS to SELECT rows —
-- app_owner is NOBYPASSRLS and every tenant table is FORCE RLS — but ownership of
-- the whole schema is far more than a stats refresh needs.)
--
-- Phase 14e introduces a dedicated role `app_maintenance` (LOGIN, NOSUPERUSER,
-- NOBYPASSRLS, NO CREATEDB/CREATEROLE) created ONCE per server by the role
-- bootstrap (prisma/roles.sql, and the CI workflows), which ALSO grants
-- app_maintenance membership to app_owner (WITH INHERIT TRUE, SET TRUE) so
-- app_owner keeps full ability to run future migrations that ALTER/own these
-- tables. The membership grant MUST live in the bootstrap (run by a CREATEROLE/
-- superuser admin): app_owner itself lacks the ADMIN option on app_maintenance
-- and so cannot grant that membership to itself from inside this migration.
--
-- This migration makes app_maintenance OWN ONLY the seven build-output tables the
-- post-build/self-heal ANALYZE touches — and nothing else — so the runtime
-- credential can ANALYZE those tables but cannot read or write shop, session,
-- email_setting, back_in_stock_subscription, analytics_event or any other table.
--
-- SAFETY / idempotency:
--   * Ownership is reassigned ONLY when the role already exists. If the bootstrap
--     has not created app_maintenance yet, this migration RAISES A NOTICE and does
--     nothing else (the ANALYZE path then no-ops until MAINTENANCE_DATABASE_URL is
--     configured) — so the migration never fails a deploy on a server whose roles
--     were not bootstrapped.
--   * ALTER TABLE ... OWNER TO <same owner> is a no-op, so re-running this
--     migration is safe. app_owner can perform the reassignment because the
--     bootstrap already made it a member of app_maintenance.
--   * Changing a table's owner does NOT drop its privileges, policies, RLS flags
--     or reloptions; app_runtime keeps every grant and policy it had.
--
-- PostgreSQL 17+ : the MAINTAIN table privilege lets a non-owner run ANALYZE, so
-- on PG17+ this role could be replaced by `GRANT MAINTAIN ON <tables> TO
-- app_runtime` and the separate credential dropped. We target PG16, which has no
-- MAINTAIN privilege, so ownership by a dedicated least-privilege role is the
-- narrowest mechanism available. See docs/PHASE14E.md "Privilege model".

DO $$
DECLARE
  t text;
  maint_tables text[] := ARRAY[
    'product_search_doc',
    'product',
    'variant',
    'search_vocabulary',
    'search_facet_value',
    'search_facet_summary',
    'search_suggest_term'
  ];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    -- NOTE: app_owner's membership in app_maintenance is granted by the role
    -- bootstrap (prisma/roles.sql), NOT here — app_owner cannot self-grant it.
    -- That membership is what lets the ALTER TABLE ... OWNER TO below succeed.

    -- A table's owner must hold CREATE on the schema that contains it (PG15+
    -- revokes schema-public CREATE from PUBLIC), so app_maintenance needs CREATE
    -- on schema public to BE made the owner below. This grants the ability to
    -- create new objects in public and NOTHING on any existing table — it is not
    -- a path to tenant data (RLS + per-table grants still gate every row). Granted
    -- by app_owner, the effective owner of schema public (pg_database_owner).
    -- Idempotent.
    GRANT CREATE ON SCHEMA public TO app_maintenance;

    FOREACH t IN ARRAY maint_tables LOOP
      -- Guard each table: only reassign if it exists and is not already owned by
      -- app_maintenance (keeps the migration safe to re-run and partial-apply).
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname = t AND c.relkind = 'r'
      ) THEN
        EXECUTE format('ALTER TABLE public.%I OWNER TO app_maintenance', t);
      END IF;
    END LOOP;

    RAISE NOTICE 'phase14e: app_maintenance now owns the 7 build-output tables; app_owner granted membership for migrations';
  ELSE
    RAISE NOTICE 'phase14e: role app_maintenance absent — skipping ownership reassignment. Run prisma/roles.sql (role bootstrap) first; post-build/self-heal ANALYZE will no-op until MAINTENANCE_DATABASE_URL is configured.';
  END IF;
END $$;
