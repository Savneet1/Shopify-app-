# Phase 3.0 Preflight — Results

Run before Phase 3.1. Global rules unchanged (no Redis/external search/AI/paid
SaaS/new scopes without approval). Date: 2026-09-22.

## Environment constraint affecting G1 and G3

This build environment's egress proxy **denies `binaries.prisma.sh` (HTTP 403,
organization policy)**, which its own rules say must not be routed around. Prisma
downloads its query/schema engines from that host, so `prisma generate` cannot
complete here — verified again this session, and also via the npm-distributed
driver-adapter/query-compiler path, which still triggers the same engine fetch.
Therefore the **live-Prisma parts of G1 and G3 cannot be executed in this
sandbox.** All their CODE is done and will run on a machine with engine access.
Everything not requiring the engine (G2, G4–G10) is done and verified here.

## Gate results

| Gate | Result |
|---|---|
| **G1** Prisma-integration test must RUN + extend (claimWebhook/markWebhookProcessed + chunked full sync) | **Code done; RUNS on an engine-enabled machine, SKIPS here.** `test/prisma-integration.test.ts` now covers runFullSync (chunked via `SYNC_CHUNK_SIZE=1`) + incremental + activation + claimWebhook/markWebhookProcessed through the real Prisma `withShopExec`. It self-skips when `getPrisma()` cannot connect (engine unavailable) with an explicit console message. |
| **G2** Fix uncast Phase 1 SQL + audit | **Done.** `CLAIM_WEBHOOK_SQL` / `MARK_WEBHOOK_PROCESSED_SQL` now use `$1::uuid`. Repo-wide audit found no other uncast uuid/jsonb/timestamptz bindings. |
| **G3** Real `npm run worker` + deployable with `npm ci --omit=dev` | **Deployability done + verified; live run needs the engine.** Added `worker:build` (vite SSR bundle → `build/worker/run-worker.js`, node_modules externalised) so the runtime image needs only prod deps; `worker` runs the bundle; `worker:dev` uses vite-node; env via optional dotenv or `--env-file`. The bundle builds here and RUNS — it connects and then stops exactly at `new PrismaClient()` because `prisma generate` (engine) can't run in this sandbox (log below). The pg-boss worker lifecycle (start → process → SIGTERM) is proven via `worker:smoke`. |
| **G4** Reconciliation race (snapshot start time) | **Done + tested.** Snapshot start captured before the bulk op (`bulk.server` → `BulkFetchResult.snapshotStartedAt` → `runFullSync`); `softDeleteProductsNotIn/CollectionsNotIn` only delete rows with `updated_at < snapshotStartedAt`. Test G4: a product created by webhook after the snapshot survives; an older absent product is deleted. |
| **G5** Catch-up boundary safety margin | **Done + documented.** Activation catch-up uses `snapshot_at - CATCHUP_MARGIN_SECONDS` (default 5s); catch-up upserts are idempotent. |
| **G6** Incremental refetch must not truncate | **Done + tested.** `fetchProductNode` paginates variants + collections fully; the normalizer sets `variantsComplete`/`collectionsComplete` from `pageInfo.hasNextPage`; reconcile is skipped when incomplete. Test: 300 variants sync without truncation; a `hasNextPage` page does not delete unseen variants. |
| **G7** Collection webhooks refresh member docs | **Done + tested.** `applyCollectionChange` refreshes member products' docs in the active version (chunked) after a rename/delete. Test: rename updates member doc text. |
| **G8** Scheduled reconciliation via pg-boss | **Done + tested + verified.** `boss.schedule(maintenance-reconcile, RECONCILE_CRON)` enqueues a full sync for installed shops not synced within `RECONCILE_INTERVAL` (24h), enumerated via the SECURITY DEFINER `app_shops_needing_full_sync()` (RLS-safe). Test: only shops needing a sync are enqueued. **Verified:** `products/update` does NOT reliably fire on collection-membership changes (esp. smart collections) — so this periodic tick + `collections/update` handling (G7) are the drift safety net. |
| **G9** Full-sync enqueue policy | **Done + tested.** Queue policy changed `singleton → stately` (≤1 queued AND ≤1 active per shop), so repeated clicks don't pile up. Test: 3 enqueues with one singletonKey collapse to a single queued job. |
| **G10** Correct FEATURE_MATRIX H7/H12 | **Done.** H7/H12 now state exactly what is verified (pg-boss lifecycle via smoke; Prisma execution only on an engine-enabled machine). |

## Command outputs

```
npm test        → Test Files 15 passed (15)   Tests 77 passed | 2 skipped (79)
npm run typecheck → 0 errors
npm run build     → exit 0
npm run worker:build → worker bundled -> build/worker/run-worker.js (deps externalised)
```
New preflight tests: `phase3-preflight` 4, `sync-serialization` +1 (empty-result guard, 5 total),
`jobs-pgboss.integration` +1 (G9 stately, 4 total), `prisma-integration` 2 (skipped here).
Migrations 0001–0005 apply cleanly to a fresh database.

**Real worker (`npm run worker`) log — stops at the engine block:**
```
> node build/worker/run-worker.js
Error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.
    at new PrismaClient (.../.prisma/client/default.js:43:11)
    at getPrisma (build/worker/run-worker.js)
```

**Worker runtime lifecycle (`npm run worker:smoke`):**
```
[worker] started; connected as app_runtime (migrate:false)
[worker] processing job <uuid> {"hello":"world","shopId":"demo"}
[worker] job processed: true
[worker] SIGTERM received; shutting down gracefully
[worker] stopped
```

## What still requires an engine-enabled machine

- G1: the actual Prisma test RUN (it is written and self-skips here).
- G3: the actual Prisma-backed `npm run worker` connecting and processing a real
  job (the bundle + pg-boss lifecycle are proven; only the Prisma instantiation
  is blocked here).

Sources for G8 verification: Shopify Community/Dev forums on
`products/update` not firing for collection membership changes, and the missing
event for smart-collection membership.
