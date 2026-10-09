# Search, Filter & Discovery (Boost-like) — Shopify App

A production-grade, multi-tenant Shopify **Search, Filter & Discovery** app built
on the current official **Shopify React Router** template, with PostgreSQL as the
only data/search engine. This repository is at **Phase 9 (Recommendations)**.

> Phase gating is enforced. Implemented so far: Phase 1 (foundation: auth,
> embedded shell, multi-tenancy + RLS, privacy webhooks, billing), Phase 2/2.1
> (catalog sync + versioned index + pg-boss worker), Phase 3 (PostgreSQL FTS,
> App Proxy storefront API, playground), Phase 4 (filters + facets), Phase 5
> (typo tolerance, synonyms, stop words, redirects, rule-based ranking), Phase 6
> (rule-based natural-language query parser), Phase 6.1 (parser fix batch:
> thousands/`~`/`between` price parsing + year/unit guards, case-insensitive
> live attribute values, negation transparency, control-character safety),
> Phase 6.1b (all-casings facet resolution, malformed-grouping guard,
> ambiguous-cue gate), Phase 7 (theme app extension: app embed predictive search
> + search-results app block, proxy-only storefront JS with native fallback, URL
> state, mobile, WCAG 2.1 AA, admin install/status page), Phase 8 (merchandising
> rules pin/boost/demote/hide + scheduling, banners, deterministic A/B testing —
> all inside the one query planner), Phase 8.1 (consent-gated A/B token, public
> beacon + token hardening, pin-order honesty), Phase 8.1b (merchant checkbox
> toggles honour an unchecked box), Phase 9 (recommendations: content-based
> similar/related, trending from an aggregate first-party signal beacon,
> frequently-bought-together algorithm over an abstract basket source —
> **no orders scope, synthetic source only**, recently-viewed client-side with
> consent gating, proxy API + theme block + admin). Analytics/bundles/etc.
> are later phases. See `docs/PHASE*.md`. Stack unchanged:
> no Redis, no external search/AI, PostgreSQL-only; scopes = `read_products`
> (Phase 9 adds no scope; real FBT order data = Requires Verification).

## Stack (Phase 1)

- Node.js 20–22, TypeScript
- React Router v7 + `@shopify/shopify-app-react-router` (embedded, managed install)
- App Bridge + **Polaris web components** (via the framework `AppProvider`)
- Prisma ORM + PostgreSQL 16 (FTS/`pg_trgm`/`unaccent` reserved for later phases)
- **pg-boss** (PostgreSQL-backed background jobs — Phase 2; no Redis)
- Admin GraphQL API **2026-07** (latest stable); **Bulk Operations** for sync
- Zod (env/input validation), Pino (logging)
- Vitest + node-postgres (tests)

Scopes: **`read_products`** (Phase 2 catalog sync). Phase 1 requested none.

## Prerequisites

- Node.js 20.10+ (`<23`)
- PostgreSQL 16 reachable via connection URL
- Shopify Partner/Dev account + a development store
- Shopify CLI (`npm i -g @shopify/cli`) — v4.x

## One-time database setup

Two roles are required by design (both `NOSUPERUSER`, `NOBYPASSRLS`):

```bash
# As a DB admin (superuser/createrole):
psql "$ADMIN_URL" -f prisma/roles.sql          # creates app_owner, app_runtime
psql "$ADMIN_URL" -c "CREATE DATABASE boostlike_dev OWNER app_owner;"
```

Set `.env` from `.env.example`:

- `DATABASE_URL` → **app_runtime** (runtime; RLS-enforced)
- `DIRECT_DATABASE_URL` → **app_owner** (migrations only)

## Install, migrate, run

```bash
npm install
npm run prisma:generate          # requires network access to Prisma engines
npm run migrate:deploy           # applies prisma/migrations as app_owner
npm run dev                      # `shopify app dev` — links app + opens tunnel
```

`shopify app dev` will prompt you to select/create an app and dev store, then
inject `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, and `SCOPES`.

> Offline/egress-restricted environments: if `prisma generate`/`migrate` cannot
> reach `binaries.prisma.sh`, apply migrations directly with
> `DIRECT_DATABASE_URL=... scripts/db-apply.sh` (uses `psql`). This is how the
> Phase 1 automated tests were executed. See docs/PHASE1.md §6.

## Tests

```bash
# Requires the TEST databases + roles (see .env.example TEST_* vars)
npm test                 # all suites
npm run test:isolation   # RLS/tenant DB suites only
```

## Shopify dev-store setup

1. In the Partner/Dev Dashboard, create an app (or let `shopify app dev` do it).
2. `shopify app config link` to bind `shopify.app.toml` (fills `client_id`).
3. `shopify app deploy` to push config (scopes = "", API 2026-07, webhooks).
4. Install on your development store from the dashboard / `shopify app dev`.

## Phase 2 — catalog sync & background worker

Phase 2 adds catalog synchronization and a versioned search index driven by
pg-boss jobs.

**One-time (operator, as app_owner):** install the pg-boss schema so the runtime
role does not need elevated privileges:

```bash
npm run pgboss:install      # uses DIRECT_DATABASE_URL (app_owner)
```

**Run the worker** as a separate process from the web app:

```bash
npm run worker              # vite-node app/lib/jobs/run-worker.ts (~ resolved, .env loaded)
# production: run the same entry with your process manager / bundle.
```

The worker needs the same env as the app (`DATABASE_URL` = app_runtime;
`SHOPIFY_API_KEY/SECRET/APP_URL` for the Admin API during full sync). It runs
pg-boss with `migrate:false` (schema installed above).

Additional env vars (see `.env.example`):

- `BOSS_DATABASE_URL` — optional; defaults to `DATABASE_URL` (app_runtime).
- `BOSS_SCHEMA` — pg-boss schema (default `pgboss`).
- `BOSS_MIGRATE` — set `true` ONLY for the operator install connection.
- `WORKER_CONCURRENCY` — incremental worker concurrency (default 2).
- `SYNC_CHUNK_SIZE` — products per transaction during full sync (default 500).

Trigger a full sync from the embedded admin (**Catalog sync** page → *Run full
catalog sync*) or via `enqueueFullSync(shopId)`. Catalog webhooks
(`products/*`, `collections/*`) drive incremental updates: each is an
"entity changed" notification and the worker re-fetches the entity by GID.

> pg-boss is installed once by app_owner; the runtime role has **no**
> `CREATE ON DATABASE` and remains NOSUPERUSER/NOBYPASSRLS (least privilege).

## Documentation

- `docs/ARCHITECTURE.md` — system + data model, phase boundaries
- `docs/SECURITY.md` — tenancy model, RLS, threat notes, known limitations
- `docs/FEATURE_MATRIX.md` — full feature matrix (implemented / planned / blocked)
- `docs/PHASE1.md` — the complete Phase 1 implementation report
- `docs/PHASE2.md` — the complete Phase 2 implementation report (sync + index)
- `docs/PHASE2_1.md` — the Phase 2.1 hardening report
