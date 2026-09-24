# Security & Tenant Isolation (Phase 1)

This is not a security certification. It documents the Phase 1 security model,
what is tested, and known limitations / future hardening.

## Tenant isolation model

1. **Server-derived identity.** The shop domain comes only from the Shopify-
   verified session (`session.shop`). It is validated against
   `^[a-z0-9][a-z0-9-]*\.myshopify\.com$` (`ShopDomainSchema`). Client-supplied
   values (`?shop=`, body, arbitrary headers) are never used for authorization.
2. **Bootstrap.** `app_resolve_shop(domain)` (SECURITY DEFINER, `search_path`
   pinned) upserts and returns the internal `shop.id` for exactly that domain —
   the only elevated path exposed to the runtime role, constrained to a single
   exact-domain lookup.
3. **Context.** `withShop(shopId, fn)` opens a transaction and runs
   `SELECT set_config('app.shop_id', $1, true)` (= `SET LOCAL`), so the context
   is transaction-scoped and cannot leak across pooled connections.
4. **Enforcement.** Every tenant table has RLS with
   `USING/WITH CHECK (shop_id = app_current_shop())`. `app_current_shop()`
   returns `NULL` when the GUC is unset → **fail-closed** (no rows, inserts
   rejected). Child tables also use `FORCE ROW LEVEL SECURITY`.
5. **Least privilege.** `app_runtime` is `NOSUPERUSER`, `NOBYPASSRLS`, and is not
   the table owner; it holds only DML + EXECUTE on the two helper functions.
   Migrations run as `app_owner` (separate connection).

## What is verified by automated tests (real PostgreSQL)

- Runtime role is `NOSUPERUSER` and `NOBYPASSRLS`.
- RLS enabled on all 7 tenant tables.
- Cross-shop **read** blocked; cross-shop **write** rejected by `WITH CHECK`.
- No-context queries are fail-closed (0 rows).
- Webhook receipt is idempotent and tenant-bound (cannot record for another shop).
- HMAC verification: valid accepted; tampered/wrong-secret/missing/short rejected;
  constant-time compare; no throw on length mismatch.
- Tenant identity validation rejects `evil.com`, suffix tricks, SQL-injection-like
  strings, and empty input — before any DB call.

> Test-scope note (approved change, 2026-09-19): the exhaustive 8-category
> isolation matrix from Phase 0 Rev 2 was reduced by the product owner to basic
> auth/webhook/database tests. The isolation *implementation* (RLS, withShop,
> non-bypass role) is unchanged; representative cross-shop read/write checks are
> retained. See docs/PHASE1.md §17.

## Phase 2 / 2.1 — background jobs & catalog

- **Job tenant ownership.** Every pg-boss job payload carries a server-derived
  `shopId`; handlers run all data access through `withShop`, so a worker can only
  touch the shop bound by that id. `job_audit`/`sync_run` writes are RLS-checked
  (a worker cannot even record a job for another shop). Dead-letter **retry**
  re-verifies ownership (`data->>'shopId'` must equal the authenticated shop)
  before re-enqueuing.
- **pg-boss least privilege (2.1).** pg-boss is installed once by `app_owner`
  (`npm run pgboss:install`); the app/worker run with `migrate:false`. Default
  privileges grant `app_runtime` on owner-created pgboss objects. `app_runtime`
  has **no `CREATE ON DATABASE`** and remains NOSUPERUSER/NOBYPASSRLS. The
  `pgboss` schema is infrastructure (no RLS), like the `session` table.
- **Uninstall / redaction.** `app/uninstalled` and `shop/redact` purge the
  shop's queued + dead-lettered jobs (`purgeShopJobs`); handlers verify the shop
  is still installed and DROP (not retry) jobs for removed shops.
- **Injection safety.** All Phase 2 SQL is parameterized with explicit casts
  (`::uuid` etc.). The only identifier interpolated into SQL is the pg-boss
  schema name, taken from env and sanitized to `[A-Za-z0-9_]`.

## Deliberate exceptions & known limitations

- **`session` table has no RLS.** It is read by session id during auth, before
  tenant context exists. Isolation relies on the authentication layer (session
  id is unguessable and derived from Shopify-verified context). Future
  hardening: encrypt access tokens at rest. This table stores Shopify access
  tokens — protect the DB credentials accordingly.
- **`shop` table is RLS-ENABLED but not FORCED**, so the SECURITY DEFINER
  resolver (running as owner) can perform the domain bootstrap. `app_runtime`
  remains constrained (own row only; no INSERT/DELETE policy).
- **Live OAuth/install flow is not automated** in tests (needs a real store);
  it is exercised manually via `shopify app dev`. Framework-level HMAC on
  webhooks is provided by `authenticate.webhook`; our standalone verifier adds
  defense-in-depth and is unit-tested.
- **No security certification / pen-test** has been performed.

## Secrets & logging

- Pino logger redacts `accessToken`, `authorization`, `x-shopify-hmac-sha256`,
  `hmac`, `password`.
- No secrets are committed; `.env` is git-ignored (`.env.example` documents keys).

## Injection safety

- All dynamic SQL uses parameterized queries (`$1..$n`). No string interpolation
  of user input into SQL. RLS policy SQL is static. `search_path` is pinned on
  both helper functions to prevent search-path hijacking.
