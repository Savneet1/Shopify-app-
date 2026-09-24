# Phase 2 — Implementation Report

Custom Shopify Search, Filter & Discovery app. Phase 0 Rev 2 approved; Phase 1
complete; **Phase 2 implemented here. Phase 3 NOT started.** Date: 2026-09-21.

Builds on the Phase 1 foundation (embedded auth, multi-tenancy, RLS, `withShop`,
privacy webhooks, billing) — all preserved unchanged.

> **Addendum:** a hardening pass (out-of-order/reconciliation/build-swap race,
> re-fetch incremental, per-shop serialization, worker runnability, pg-boss
> least-privilege, dashboard DLQ) is documented in **`docs/PHASE2_1.md`**. Where
> that report differs from the notes below (e.g. pg-boss no longer needs
> `CREATE ON DATABASE`), PHASE2_1 is current.

---

## 1. Phase 2 Implementation Summary

Phase 2 adds catalog synchronization and a versioned search index, driven by
PostgreSQL-backed background jobs (pg-boss). No Redis, no external search
engine, no AI/embeddings/pgvector, no paid SaaS.

- **Catalog sync** — full sync via Shopify **Bulk Operations** (JSONL, API
  2026-07) and **incremental** sync via product/collection webhooks. Catalog
  tables: `product`, `variant`, `collection`, `product_collection`, `metafield`.
- **Versioned index** — `index_version` + `product_search_doc` with a
  **build → validate → atomic swap → rollback** lifecycle. A partially built
  version is never active; a DB partial-unique index enforces at most one active
  version per shop; interrupted builds are recovered without touching the active
  index. (This builds and versions the search DOCUMENTS; full-text search /
  ranking / typo / synonyms are Phase 3+ and are NOT implemented.)
- **Background jobs (pg-boss)** — retry + exponential backoff, dead-letter
  queues, enqueue dedup (`short` policy + singletonKey), processing idempotency
  (`job_audit`), per-shop serialization, and crash recovery. Every job payload
  carries a server-derived `shopId`; handlers only ever touch that shop via
  `withShop` (RLS-bound).
- **Sync dashboard** — an embedded admin page showing sync status / index
  versions and a button to trigger a full sync.
- **Tenant safety preserved** — `shop_id` + RLS(+FORCE) on all 11 new tables;
  `app_runtime` remains NOSUPERUSER/NOBYPASSRLS.

**Result: 60 automated tests passing (30 Phase 1 + 30 Phase 2), typecheck clean,
build clean, migrations apply from scratch.**

## 2. Files Created / Modified

**Created (app):** `app/lib/db/executor.ts`, `app/lib/catalog/store.ts`,
`app/lib/catalog/bulk-parse.ts`, `app/lib/catalog/webhook-map.ts`,
`app/lib/index/engine.ts`, `app/lib/sync/store.ts`, `app/lib/sync/orchestrator.ts`,
`app/lib/jobs/queue.ts`, `app/lib/jobs/handlers.ts`, `app/lib/jobs/worker.ts`,
`app/lib/jobs/run-worker.ts`, `app/lib/shopify/bulk.server.ts`,
`app/routes/app.sync.tsx`, `app/routes/webhooks.catalog.tsx`,
`app/routes/webhooks.bulk-operations-finish.tsx`.

**Created (db):** `prisma/migrations/0003_phase2_catalog_index/migration.sql`.

**Created (tests):** `test/catalog-store.test.ts`, `test/index-versioning.test.ts`,
`test/sync-orchestrator.test.ts`, `test/jobs-idempotency.test.ts`,
`test/jobs-pgboss.integration.test.ts`, `test/webhook-map.test.ts`.

**Modified:** `app/lib/tenant.server.ts` (+`withShopExec`),
`test/helpers/db.ts` (+`pgExec`/`withShopExec`), `app/routes.ts` (+sync +catalog
webhooks), `app/routes/app.tsx` (nav link), `prisma/schema.prisma` (+11 models),
`shopify.app.toml` (`read_products` + catalog/bulk webhooks), `package.json`
(+pg-boss), `docs/*`.

## 3. Dependencies Added

| Package | Version | Purpose | License | External service/account | Data egress |
|---|---|---|---|---|---|
| `pg-boss` | 12.33.3 | PostgreSQL-backed job queue (Phase-0 approved) | MIT | None | None (uses your Postgres) |

No other runtime dependencies. `pg-boss` was explicitly planned in Phase 0. It
can't reasonably be replaced by an in-house queue at the same reliability. No
Redis, no external queue/search/AI SaaS. (Test-only `pg` from Phase 1 is reused.)

## 4. Shopify Documentation Verification (2026-09-21)

- **API version:** 2026-07 (latest stable; unchanged from Phase 1).
- **Bulk Operations (queries):** `bulkOperationRunQuery` → poll
  `currentBulkOperation(type: QUERY)` for `status` (`CREATED/RUNNING/COMPLETED/
  FAILED/CANCELED`) and the signed JSONL `url`; nested connections flatten with
  `__parentId`. Completion also signalled by the `bulk_operations/finish`
  webhook. **We poll to completion** and serialize one bulk query per shop.
- **Concurrency limit:** the exact number of simultaneous bulk operations per
  shop is **REQUIRES VERIFICATION** (historically 1; reportedly raised). Our
  design serializes our own bulk query per shop (queue singletonKey), which is
  safe under any limit.
- **Scopes:** `read_products` grants Product/ProductVariant/Collection — exactly
  the catalog data we read. Added as the only Phase 2 scope. Inventory quantity
  may require `read_inventory` — **REQUIRES VERIFICATION**, deferred.
- **Webhooks used:** `products/create|update|delete`,
  `collections/create|update|delete`, `bulk_operations/finish` (declared in
  `shopify.app.toml`; HMAC-verified by `authenticate.webhook`).
- **APIs used:** Admin GraphQL (bulk operations); webhook payloads (REST-shaped).

## 5. Database Changes (migration 0003)

New tenant tables (all with `shop_id` + RLS + FORCE + tenant policy):
`product`, `variant`, `collection`, `product_collection`, `metafield`,
`index_version`, `product_search_doc`, `index_consistency_check`, `sync_run`,
`sync_failure`, `job_audit`. Key constraints: unique
`(shop_id, shopify_*_gid)` upsert keys; **partial unique**
`index_version(shop_id) WHERE status='active'` (safe swap);
`job_audit(shop_id, dedupe_key)` (idempotency). Also: `pgboss` schema created
(owner) with `USAGE, CREATE` for `app_runtime`, and `GRANT CREATE ON DATABASE`
to `app_runtime` so pg-boss self-migrates (no SUPERUSER/BYPASSRLS granted).

## 6. Background Job Architecture

- **Engine:** pg-boss 12 in the `pgboss` schema, connecting as `app_runtime`.
- **Queues:** `catalog-sync-full` and `catalog-incremental`, each with a
  dead-letter queue. `policy: short` (drops duplicate enqueues per singletonKey),
  `retryLimit` + `retryBackoff` (exponential), `deadLetter`, `expireInSeconds`.
- **Idempotency/dedup:** enqueue dedup via singletonKey; processing via
  `beginJobAttempt` (`job_audit`) — retries of unfinished jobs proceed, but work
  that already **completed** is skipped (safe under at-least-once delivery /
  duplicate Shopify events).
- **Tenant ownership:** job payloads carry a server-derived `shopId`; handlers
  run everything through `withShop`, so a worker can never process another
  shop's data. `job_audit` inserts are RLS-checked (a worker cannot even record
  a job for another shop).
- **Concurrency/recovery:** full syncs serialize per shop (singletonKey =
  shop). On restart pg-boss re-delivers in-flight jobs; the full-sync handler
  calls `recoverInterruptedBuilds` first, so a crash never leaves a corrupt
  active index.

## 7. Catalog Sync Architecture

- **Full:** `fetchBulkCatalog(shopId)` runs the products + collections bulk
  queries, polls to `COMPLETED`, downloads JSONL. `parseProductsJsonl` /
  `parseCollectionsJsonl` group variants + collection memberships via
  `__parentId`. `runFullSync` upserts collections → products/variants/
  memberships (idempotent `ON CONFLICT`), then rebuilds the index.
- **Incremental:** catalog webhooks → `mapCatalogWebhook` (REST payload →
  normalized, numeric id → gid) → `catalog-incremental` job →
  `applyProductUpsert` / `applyProductDeletion` / collection equivalents →
  in-place refresh of the changed product's doc in the **active** index
  (`refreshDocInActiveVersion`), keeping the live index current and serving.

## 8. Index Versioning / Atomic Swap / Rollback

State machine (per shop):

```
createIndexVersion         -> building
buildDocs                  -> validating
validateIndexVersion pass  -> validated ;  fail -> failed
activateIndexVersion       -> active   (prior active -> superseded; docs retained)
rollbackToVersion          -> active   (current active -> rolled_back)
recoverInterruptedBuilds   -> failed   (building/validating, partial docs purged)
```

- **Never expose a partial index:** only `validated` versions can be activated;
  `activateIndexVersion` throws otherwise. The DB partial-unique index makes two
  active versions impossible.
- **Atomic swap:** demote-active + promote-target run in one `withShop`
  transaction → no window with zero or two active versions.
- **Rollback:** re-activates a retained prior version (`superseded`/`validated`/
  `rolled_back`); `pruneOldVersions` keeps the last N for rollback.
- **Validation:** integrity = every live product has exactly one doc; a
  Shopify-vs-DB count drift is recorded as a warning, not an integrity failure.

## 9. Test Results (exact)

Command: `npm test` (Vitest) against real PostgreSQL 16 (`app_runtime`).

```
Test Files  11 passed (11)
Tests       60 passed (60)   (0 failed, 0 skipped)
```

Per file — Phase 1: database-rls 7, tenant-withshop 10, webhook-hmac 5,
webhook-idempotency 3, billing 5 (=30). **Phase 2:** catalog-store 5,
index-versioning 8, sync-orchestrator 5, jobs-idempotency 5,
jobs-pgboss.integration 3, webhook-map 4 (=30).

Phase 2 coverage → catalog sync + upsert idempotency + tenant isolation
(catalog-store, sync-orchestrator); incremental updates (sync-orchestrator);
index create/validate/**atomic swap**/rollback/partial-never-active/**interrupted
recovery** (index-versioning); job idempotency/dedup/retry/tenant-ownership
(jobs-idempotency); **end-to-end pg-boss enqueue→process→active index + dedup +
dead-letter** (jobs-pgboss.integration); webhook payload mapping (webhook-map).

- `npm run typecheck` → `react-router typegen` + `tsc --noEmit` → **0 errors**.
- `npm run build` → **exit 0** (client + SSR bundles).
- Migrations 0001–0003 apply cleanly to a fresh database (18 RLS tenant tables).

## 10. Feature Matrix Changes

`docs/FEATURE_MATRIX.md` updated: **F2 (bulk/incremental sync, versioned indexer,
job safety) → Implemented**, with sub-rows for catalog model, bulk parse,
versioned index engine, atomic swap/rollback, pg-boss jobs, incremental
webhooks, and the sync dashboard. `read_products` recorded as the Phase 2 scope.

## 11. Known Limitations / REQUIRES VERIFICATION

- **Live Shopify calls not run in CI:** `fetchBulkCatalog` (bulk run/poll/
  download) needs a real store; it is verified manually via `shopify app dev`.
  The job pipeline is tested end-to-end with injected sample JSONL.
- **Bulk-op concurrency limit** per shop — REQUIRES VERIFICATION (design is safe
  regardless; we serialize per shop).
- **Inventory quantity fields** may need `read_inventory` — REQUIRES
  VERIFICATION; not indexed in Phase 2.
- **Bulk JSONL parsing is in-memory** (two-pass). Fine for typical catalogs;
  streaming/large-catalog handling is a Phase 14 performance concern.
- **`bulk_operations/finish`** webhook is acknowledged but not yet used to
  replace polling (documented future optimization).
- **No search functionality** (FTS, ranking, typo, synonyms, filters) — Phase 3+.
- **No performance targets measured** — not claimed.

## 12. Deviations From Phase 0 / Phase 1

- Incremental index updates are applied **in place to the active version**
  (single-row upsert), while full rebuilds use the versioned build→validate→swap
  path. This matches the Phase 0 "incremental updates" capability and never
  exposes a partial index. It is an implementation detail consistent with the
  approved design, noted for transparency.
- pg-boss requires `CREATE ON DATABASE` for `app_runtime` to self-migrate its
  schema. This does **not** grant SUPERUSER or BYPASSRLS; tenant RLS is intact.
  Noted as a bounded privilege decision.

Otherwise: **No deviations from the approved architecture.** The Phase 1 tenant
model (server-side identity, `shop_id`, RLS/FORCE, non-bypass role, `withShop`,
parameterized SQL, webhook HMAC + receipts) is fully preserved.

---

**PHASE 2 COMPLETE. PHASE 3 NOT STARTED. AWAITING EXPLICIT USER APPROVAL.**
