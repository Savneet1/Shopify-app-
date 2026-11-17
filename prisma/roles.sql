-- One-time database role setup. Run ONCE per PostgreSQL server by an operator
-- with CREATEROLE (e.g. the DB superuser / cloud "postgres" admin) BEFORE the
-- first `prisma migrate deploy`. Idempotent.
--
-- SECURITY REQUIREMENT (Phase 0 Rev 2): both roles are NOSUPERUSER + NOBYPASSRLS.
-- The application connects ONLY as app_runtime.
--
-- Replace the passwords below before using in any shared environment.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner LOGIN PASSWORD 'CHANGE_ME_owner'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD 'CHANGE_ME_runtime'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- Phase 14e: dedicated LEAST-PRIVILEGE maintenance role. It OWNS ONLY the seven
  -- build-output tables (ownership assigned by migration 0027) so the worker can
  -- run ANALYZE on them via MAINTENANCE_DATABASE_URL — WITHOUT the migration-owner
  -- credential. NOSUPERUSER + NOBYPASSRLS + NO CREATEDB/CREATEROLE: it can touch
  -- no other table and cannot bypass RLS. See docs/PHASE14E.md "Privilege model".
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance LOGIN PASSWORD 'CHANGE_ME_maintenance'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- app_owner must stay able to run future migrations that ALTER/own the seven
  -- tables after migration 0027 hands their ownership to app_maintenance. Owner
  -- operations (ALTER TABLE, CREATE INDEX, and the ALTER ... OWNER TO in 0027)
  -- require membership in the owning role; INHERIT lets app_owner act without an
  -- explicit SET ROLE. This grant lives here (not in the migration) because only a
  -- role with ADMIN on app_maintenance — the bootstrap admin, not app_owner — may
  -- grant it. Idempotent: re-granting only updates the options.
  GRANT app_maintenance TO app_owner WITH INHERIT TRUE, SET TRUE;
END $$;

-- The database must be owned by app_owner so migrations create owner-owned
-- objects. Create it as the admin, e.g.:
--   CREATE DATABASE boostlike_dev OWNER app_owner;
-- app_runtime is granted table/function privileges by migration 0002.
