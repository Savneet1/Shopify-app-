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
END $$;

-- The database must be owned by app_owner so migrations create owner-owned
-- objects. Create it as the admin, e.g.:
--   CREATE DATABASE boostlike_dev OWNER app_owner;
-- app_runtime is granted table/function privileges by migration 0002.
