# Phase 14e — Hardening the post-build ANALYZE

Phase 14d added a synchronous post-build `ANALYZE` to keep the write path off the
stale-statistics regression (see `docs/PHASE14D.md`). Phase 14e hardens **how** that
ANALYZE runs, driven by four findings on the 14d implementation.

## Findings addressed

1. **Owner credential in the worker runtime.** 14d ran the ANALYZE over
   `DIRECT_DATABASE_URL` (`app_owner`). The 14d docs claimed the worker "already
   has" that credential "for migrations and pg-boss" — **false**: pg-boss connects
   with `BOSS_DATABASE_URL || DATABASE_URL` (`app_runtime`), and before 14d no
   runtime code read `DIRECT_DATABASE_URL` (migrations run as a separate step). 14d
   therefore put the schema-owning credential into the worker for the first time; a
   compromised worker could DROP/ALTER tables or (though NOBYPASSRLS blocks row
   reads) wield far more than a stats refresh needs. → **E2**.
2. **Unbounded maintenance client.** `new pg.Client(...)` had no connect or
   statement timeout and was awaited by the full-sync handler, so a hung DB could
   block the job. → **E1**.
3. **Silent degradation.** If the credential was absent or ANALYZE failed, writes
   silently became ~35× slower after each full sync, traced only by one log line.
   → **E3** (loud logs + admin notice) and **E4** (self-heal).
4. **Forced 100k stale number.** The 14d 100k stale figure was a pinned
   (`reltuples = -1`) state, not a naturally-observed one. → **E5** (relabelled in
   `docs/PHASE14D_REPORT.md`).

## E1 — timeouts and isolation

`runPostBuildAnalyze` (app/lib/jobs/analyze.server.ts) builds its client with:

| bound | value | ceiling |
|---|---|---|
| `connectionTimeoutMillis` | 10 s | ≤ 10 s |
| `statement_timeout` | 120 s | ≤ 120 s |
| `query_timeout` | 120 s | ≤ 120 s |
| overall `Promise.race` guard | 150 s | ≤ 150 s |
| `application_name` | `boostlike-maintenance` | — |

The whole unit of work (connect + ANALYZE + close) races a single 150 s timer, so
the function **always resolves within the budget** even if the client wedges
mid-connect; on timeout it abandons the client without awaiting and returns
`status: "timeout"`. It **never throws** — a failure or hang is best-effort and
must not fail or stall the sync. Tested with an injected hanging/failing client
(`test/phase14e-analyze-isolation.test.ts`).

## E2 — least privilege: the `app_maintenance` role

ANALYZE requires table ownership and PostgreSQL 16 has no `MAINTAIN` privilege, so
the refresh must connect as a role that owns the tables. Instead of the
schema-owning `app_owner`, Phase 14e adds a dedicated role that owns **only** the
seven build-output tables:

- **Role bootstrap** (`prisma/roles.sql`, both CI workflows): create
  `app_maintenance` (`LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`,
  `NOCREATEROLE`) and `GRANT app_maintenance TO app_owner WITH INHERIT TRUE, SET
  TRUE` so `app_owner` can still run future migrations that ALTER/own these tables.
  (The membership grant must be in the bootstrap — run by a CREATEROLE/superuser
  admin — because `app_owner` lacks the ADMIN option to grant it to itself.)
- **Migration 0027** (idempotent, role-guarded): only when the role exists, grant
  it `CREATE ON SCHEMA public` (required to *own* a table there under PG15+) and
  reassign ownership of the seven tables to it. If the role is absent it `RAISE
  NOTICE`s and does nothing, so a deploy on an un-bootstrapped server never fails.
- **Runtime**: `runPostBuildAnalyze` reads **`MAINTENANCE_DATABASE_URL` only** — the
  `DIRECT_DATABASE_URL` fallback is **removed**. Unset ⇒ logged no-op ⇒ autovacuum
  fallback.

Proven as the **real roles** in `test/phase14e-maintenance-role.test.ts`:
`app_maintenance` CAN ANALYZE the seven; has **no** SELECT/INSERT/UPDATE/DELETE on
`shop`, `session`, `email_setting`, `back_in_stock_subscription`,
`analytics_event`; is denied at runtime on them; its ANALYZE of a non-owned table
is skipped by the DB with a permission warning; `app_runtime` is unchanged (still
reads an `app_maintenance`-owned table under tenant RLS). A mutation guard flips a
throwaway table's ownership and shows ANALYZE capability follows ownership. The
RLS-completeness audit allowlist was updated to permit `app_maintenance` **only**
on the seven tables (`test/phase14-rls-completeness.test.ts`); the SECURITY DEFINER
allowlist is unchanged (no new definer function).

## E3 — visibility

- **Per-process record**: `runPostBuildAnalyze` stores its last outcome
  (`ok | skipped:no-url | error | timeout`), readable via
  `getLastPostBuildAnalyze()`.
- **Loud logs**: skip (no URL), failure and timeout log at **ERROR** level.
- **Admin notice**: the admin overview (`app/routes/app._index.tsx`) renders a
  generic banner — *"Database statistics maintenance is not configured or is
  failing: product updates can be much slower after a full catalog sync"* — driven
  by `checkStatsMaintenanceHealth`, which observes staleness from
  `pg_stat_user_tables` as `app_runtime` (so it is correct across the web/worker
  process split). It exposes **no** connection string or role name. Tested via the
  health signal (`test/phase14e-self-heal.test.ts`).

## E4 — self-healing stale-stats check

`runStatsSelfHeal` runs on the existing maintenance tick (worker.ts
`maintenanceReconcile`). It cheaply detects stale planner statistics on the seven
tables (read-only, as `app_runtime`: a table is stale when it has live rows and
either `reltuples < 0` — never analyzed — or has drifted > 20 % since the last
analyze) and, if stale **and** `MAINTENANCE_DATABASE_URL` is configured, runs the
same bounded ANALYZE. Throttled to at most once per 15 min, idempotent (empty
tables are never flagged, so it converges), and never throws. Tested with injected
stats (`test/phase14e-self-heal.test.ts`).

## E5 — docs

`docs/PHASE14D.md` and `docs/PHASE14D_REPORT.md` corrected (removed the "already
has DIRECT_DATABASE_URL" claim; relabelled the forced 100k stale number). This file
is the authoritative Phase 14e record; the **Privilege model** is below.

## Privilege model

| Role | LOGIN | SUPERUSER | BYPASSRLS | Owns | What it can reach |
|---|---|---|---|---|---|
| `app_runtime` | yes | no | no | nothing | Every tenant table, but only its own shop's rows (RLS ENABLED + FORCED); the allowlisted SECURITY DEFINER functions; read-only stats catalogs (`pg_stat_user_tables`, `pg_class`). The ONLY role the app/web/worker uses for tenant work. |
| `app_owner` | yes | no | no | the schema + every table **except** the seven (and, via membership in `app_maintenance`, effectively those too) | Runs migrations and the pg-boss schema install. NOBYPASSRLS, so it still cannot read tenant rows across shops. Never used for request/worker tenant work. |
| `app_maintenance` | yes | no | no | **only** the seven build-output tables (`product_search_doc`, `product`, `variant`, `search_vocabulary`, `search_facet_value`, `search_facet_summary`, `search_suggest_term`) | `ANALYZE` those seven. Has `CREATE ON SCHEMA public` (needed to own a table there) but **no** privilege on any other table, and NOBYPASSRLS — it cannot read or write `shop`, `session`, tokens, subscriber emails, SMTP credentials or anything else. Used ONLY by the post-build / self-heal ANALYZE via `MAINTENANCE_DATABASE_URL`. |

RLS stays **ENABLED + FORCED** on every tenant table and every `app_runtime`
policy/grant is unchanged; changing a table's owner does not alter its policies,
grants, RLS flags or reloptions.

**PostgreSQL 17+ note.** PG17 adds the `MAINTAIN` table privilege, which lets a
non-owner run `ANALYZE`/`VACUUM`. On PG17+ this whole role could be retired:
`GRANT MAINTAIN ON <the seven tables> TO app_runtime` and drop the separate
credential entirely. We target PG16 (no `MAINTAIN`), so a dedicated owning role is
the narrowest mechanism available today.

## Deviations / limitations

- `app_maintenance` holds `CREATE ON SCHEMA public` (unavoidable to own a table in
  `public` under PG15+). It grants the ability to create new objects in `public`
  and nothing on any existing table — not a path to tenant data.
- The admin notice is derived from observed staleness, so immediately after a very
  large build and before the synchronous ANALYZE completes it could transiently
  show; this is rare and self-clears.
- Absolute timings elsewhere remain sandbox-indicative; this phase changes
  privilege/robustness, not the measured write-path numbers.
- **The sandbox was rebuilt mid-phase.** The container was reclaimed during a pause;
  the repo was restored from the verified `boostlike-phase14d.tgz` (HEAD `e3ffe72`,
  `git fsck` clean), PostgreSQL 16 was re-initialised, roles/databases/migrations
  (through 0027) re-applied, and dependencies re-installed. The restored baseline
  reproduced **853 passed | 13 skipped** before any 14e change.
