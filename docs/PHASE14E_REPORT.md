# Phase 14e Report — Hardening the post-build ANALYZE

**Base:** `e3ffe72` (Phase 14d) · continue existing history (fast-forward).
**Scope:** Phase 14e only (E1–E5). Phase 15 NOT started.
**No** new dependency/extension, **no** new SECURITY DEFINER function. Migrations
additive/idempotent (0027). RLS stays ENABLED + FORCED; read results byte-identical.

> **Sandbox rebuilt mid-phase.** The container was reclaimed during a pause. The
> repo was restored from the re-attached `boostlike-phase14d.tgz` (sha256 verified,
> HEAD `e3ffe72`, `git fsck` clean); PostgreSQL 16 was re-initialised; roles,
> databases and migrations (through 0027) re-applied; dependencies re-installed. The
> restored baseline reproduced **853 passed | 13 skipped** before any 14e change.

## Decisions

| # | Decision | Why |
|---|---|---|
| E1 | Bound the maintenance client: connect 10 s, statement/query 120 s, overall 150 s `Promise.race`, `application_name=boostlike-maintenance`; never throws | A hung DB must never fail or stall the full-sync job |
| E2 | Dedicated least-privilege role `app_maintenance` owning only the 7 build-output tables; `MAINTENANCE_DATABASE_URL` only (DIRECT fallback removed) | Stop putting the schema-owning credential in the worker runtime |
| E2 | Membership `GRANT app_maintenance TO app_owner` lives in the **bootstrap**, ownership reassignment in **migration 0027** (role-guarded, idempotent) | app_owner lacks ADMIN on the role; migration must not fail on un-bootstrapped servers |
| E2 | `GRANT CREATE ON SCHEMA public TO app_maintenance` in 0027 | PG15+ requires a table's owner to hold CREATE on its schema; minimal and not a path to tenant data |
| E3 | Per-process outcome record + ERROR logs + admin notice derived from observed staleness | Cross-process-correct (web can't read the worker's memory); no secrets in the UI |
| E4 | Self-heal on the existing maintenance tick; throttle 15 min; stale = live rows and (`reltuples<0` or drift>20%) | Repairs a missed/failed/restarted build; empty tables never flagged ⇒ converges |
| E5 | Correct PHASE14D docs; relabel the forced 100k stale number; add Privilege model | Findings 1 & 4 |

## Role / privilege table

| Role | Owns | ANALYZE 7? | Read/write other tenant tables? | BYPASSRLS |
|---|---|---|---|---|
| `app_runtime` | nothing | no | own-shop rows only (RLS forced) | no |
| `app_owner` | schema + all except the 7 (member of app_maintenance) | via membership | no (NOBYPASSRLS) | no |
| `app_maintenance` | the 7 build-output tables only | **yes** | **no** (verified: no SELECT/INSERT/UPDATE/DELETE on shop/session/email_setting/back_in_stock_subscription/analytics_event) | no |

## Correctness

- All pre-existing behaviour unchanged; read results byte-identical (no query or
  schema-shape change — only table ownership, timeouts, and two new tick/observe
  paths). RLS ENABLED + FORCED and every `app_runtime` policy/grant unchanged.
- Migration 0027 is idempotent (re-applied twice: second run is a clean no-op) and
  role-guarded (NOTICE + skip when `app_maintenance` is absent).

## Verification

- `npm test`: **879 passed | 13 skipped** (853 prior + 26 new Phase 14e; none
  weakened). The 13 skips are `prisma-integration` (Prisma engine unavailable
  offline), unchanged from baseline.
- `npm run test:ci-parity` (strict, no `.env`): **879 passed | 13 skipped** (clean).
  One pre-existing, timing-sensitive pg-boss singleton-dedup integration test
  (`jobs-pgboss.integration > deduplicates … by singletonKey`, untouched by 14e)
  flaked once under ci-parity load and passed on isolated re-run and on a clean
  full ci-parity re-run; not a 14e regression and not weakened.
- New tests: `phase14e-analyze-isolation` (E1 timeouts/isolation + E3 record +
  allowlist guard), `phase14e-maintenance-role` (E2 real-role least privilege +
  mutation guard), `phase14e-self-heal` (E4 detection/self-heal + E3 health).
  Updated audit: `phase14-rls-completeness` (app_maintenance allowed only on the 7).
- Gates: typecheck ✓, build ✓, worker:build ✓.
- **Live-Prisma parity: PENDING** your GitHub Actions run.

## Deviations / limitations

- `app_maintenance` holds `CREATE ON SCHEMA public` (required to own a table in
  `public` under PG15+); it can create new objects but has no privilege on any
  existing table.
- The admin notice is derived from observed staleness, so it could transiently show
  during a very large build before the synchronous ANALYZE completes; self-clears.
- PostgreSQL 17+ `MAINTAIN` would let this role be retired in favour of a
  `GRANT MAINTAIN … TO app_runtime`; we target PG16 which lacks it.

**STATUS:** Phase 14e COMPLETE. The Phase 14d post-build ANALYZE is hardened: it
runs as a dedicated least-privilege role **`app_maintenance`** (owns only the seven
build-output tables, migration 0027) via **`MAINTENANCE_DATABASE_URL`** — the owner
credential is no longer used at runtime (E2); the maintenance client is bounded on
connect (≤10 s), statement (≤120 s) and overall (≤150 s `Promise.race`) and never
throws (E1); outcomes are recorded + logged at ERROR and an admin notice surfaces a
degraded/unconfigured state (E3); a throttled self-heal check on the maintenance
tick repairs stale stats after a missed/failed build (E4); and the Phase 14d docs
were corrected, with the forced 100k stale number relabelled and a Privilege model
added (E5). Verified as the real roles (`app_maintenance` can ANALYZE the seven and
cannot touch any other table; `app_runtime` unchanged; RLS ENABLED+FORCED; no new
SECURITY DEFINER). `npm test` **879 passed | 13 skipped**; ci-parity clean;
typecheck/build/worker:build green. Migration 0027 additive/idempotent/role-guarded.
Sandbox was rebuilt mid-phase (restored from the verified 14d archive). Live-Prisma
parity **PENDING** your GitHub Actions run. Awaiting explicit approval before
Phase 15.
