# Phase 2.1 — Hardening Report

Hardening pass over the Phase 2 catalog sync + versioned index. No Phase 3 work
(no search API/UI, filters, ranking, typo, synonyms, NL/semantic, analytics,
themes). No new paid services / Redis / external search / AI / another app.
Date: 2026-09-21.

## Regression tests (added first, watched fail, then fixed)

`test/phase2-hardening.test.ts` (7 tests, all green after the fixes):

| ID | Behaviour | Fix |
|---|---|---|
| P1 | stale out-of-order update must not overwrite newer data | monotonic upsert guard (`ON CONFLICT ... WHERE incoming.updated_at >= stored`) |
| P2 | late update after delete must not resurrect | soft-delete advances `shopify_updated_at` (tombstone); guard blocks un-delete |
| P3 | variant removed in Shopify disappears from catalog + doc | `reconcileProductVariants` + active-index refresh |
| P4 | full sync removes products/collections no longer in Shopify | `softDeleteProductsNotIn` / `softDeleteCollectionsNotIn` after a validated snapshot |
| P5 | webhook between buildDocs and activate survives activation | activation locks index rows + catches up changes since the build snapshot |
| P5b | delete during build reflected in the activated version | catch-up deletes docs for products soft-deleted since snapshot |
| P6 | webhook and bulk paths normalise identically (status/ACTIVE, desc, options, position, memberships) | single shared `normalizeProductNode` used by both paths |

## MUST FIX — status

1. **Incremental redesign (re-fetch by GID).** Catalog webhooks now map to
   "entity changed" jobs `{entity, gid}` (`webhook-map.ts`); the worker
   **re-fetches** the entity via Admin GraphQL (`fetchProductNode` /
   `fetchCollectionNode`) and applies it through the SAME normalizer as bulk;
   a missing entity is treated as a delete. Monotonic guard added; enqueue
   dedupe (`topic:webhookId`) retained. ✅
2. **Reconciliation.** Product upsert soft-deletes variants no longer present;
   full sync soft-deletes absent products/collections; guarded to run only after
   a validated snapshot; empty result with `objectCount>0` is an error
   (`downloadJsonl`); large-deletion safety check recorded in `sync_run.stats`/
   `.warning`. ✅
3. **Build/swap race.** `activateIndexVersion` locks the shop's index rows
   (`FOR UPDATE`), catches up every product changed/deleted since
   `index_version.snapshot_at`, then flips status. Verified by P5/P5b. ✅
4. **Prisma reality check.** (a) `test/prisma-integration.test.ts` runs
   runFullSync + incremental + activation through the real Prisma
   `withShopExec`; it **SKIPS in this sandbox because the Prisma engine binary
   cannot be downloaded** (binaries.prisma.sh is egress-blocked) and runs on a
   normal machine — see Test Results. (b) Explicit `::uuid/::jsonb/::timestamptz/
   ::int/::numeric` casts added across ALL Phase 2 SQL and the Phase 1 raw SQL
   (`sql.server.ts`, `webhooks/receipt`, `sync/store`, `catalog/store`,
   `index/engine`). (c) `withShop` transactions now set explicit
   `timeout`/`maxWait`; full sync is **chunked** (`SYNC_CHUNK_SIZE`, default 500)
   per transaction; the per-row collection lookup loop is replaced with two
   set-based statements. Each chunk is tenant-bound and idempotent (resumable). ✅
5. **Worker actually runs.** `npm run worker` (vite-node → `~` resolved via
   vite-tsconfig-paths, env via dotenv) → `app/lib/jobs/run-worker.ts`. Verified
   start → connect as app_runtime (migrate:false) → process a job → graceful
   SIGTERM via `npm run worker:smoke` (log below). No new dependency (vite-node
   ships with vitest). ✅
6. **Per-shop serialization.** Queue policy changed `short → singleton` (1 active
   per shop) AND a DB partial-unique index `sync_run(shop_id) WHERE
   status='running'` is the authoritative guard, with stale-run recovery.
   `expireInSeconds` raised to 2400 (> 30-min bulk timeout + processing).
   Verified by `test/sync-serialization.test.ts`. ✅
7. **Bulk client.** `pollBulkById` polls the SPECIFIC operation id from
   `bulkOperationRunQuery` (verified: `bulkOperation(id:)`), not
   `currentBulkOperation`. Expected product count is computed from the parsed
   data (`countProductsInJsonl`), not `objectCount`; `validateIndexVersion`
   compares the index against that snapshot count. ✅

## SHOULD FIX — status

8. **Dashboard failure/DLQ visibility.** `app/routes/app.sync.tsx` shows recent
   `sync_failure` + failed `job_audit` rows (tenant-scoped by RLS) and DLQ
   entries for the current shop only (`status.server.ts`, filtered by
   `data->>'shopId'`), with a **Retry** action that re-verifies ownership
   server-side before re-enqueuing. ✅
9. **Uninstall/redaction.** Handlers verify the shop is still installed and DROP
   (not retry) jobs for removed shops (`isShopInstalled`); `app/uninstalled` and
   `shop/redact` call `purgeShopJobs` (queues + DLQ + archive). ✅
10. **Prune + rollback rebuild.** `pruneOldVersions` runs after a successful
    activation; `rollbackAndScheduleRebuild` rolls back then enqueues a full
    rebuild (retained versions are stale — documented). ✅
11. **ensureQueues.** No longer caches a rejected start promise. ✅
12. **Inventory.** Availability fields readable at the read_products object level
    are synced + indexed: `Product.totalInventory`, `Product.tracksInventory`,
    `ProductVariant.availableForSale`. Numeric `inventoryQuantity` is NOT synced
    (needs `read_inventory`); **no new scope added, so no approval needed** — see
    REQUIRES VERIFICATION. ✅
13. **pg-boss privileges.** pg-boss 12 is now installed ONCE by app_owner
    (`npm run pgboss:install`); the app/worker run with `migrate:false`. Default
    privileges grant app_runtime on owner-created pgboss objects. **The
    `CREATE ON DATABASE` grant was removed** — app_runtime is stricter than in
    Phase 2. ✅

## Exact command outputs

```
$ npm test         → Test Files 14 passed (14)   Tests 72 passed | 1 skipped (73)
$ npm run typecheck → react-router typegen + tsc --noEmit → 0 errors
$ npm run build     → exit 0 (client + SSR bundles)
```

Per file — Phase 1 (30): database-rls 7, tenant-withshop 10, webhook-hmac 5,
webhook-idempotency 3, billing 5. Phase 2 + 2.1 (43): catalog-store 5,
index-versioning 8, sync-orchestrator 5, jobs-idempotency 5,
jobs-pgboss.integration 3, webhook-map 4, **phase2-hardening 7**,
**sync-serialization 5**, **prisma-integration 1 (skipped)**.

Prisma-backed integration test:
```
[prisma-integration] SKIPPED: Prisma engine unavailable in this environment
  (Prisma failed to fetch libquery_engine from binaries.prisma.sh — egress blocked)
```
It runs in full on a machine where `prisma generate` can fetch the engine.

Worker start / process / shutdown (`npm run worker:smoke`):
```
[worker] started; connected as app_runtime (migrate:false)
[worker] processing job <uuid> {"hello":"world","shopId":"demo"}
[worker] job processed: true
[worker] SIGTERM received; shutting down gracefully
[worker] stopped
```
(`npm run worker` is the production entry; it additionally instantiates Prisma,
so it requires the Prisma engine — see the skip note above.)

Migrations: 0001–0004 apply cleanly to a fresh database (18 RLS tenant tables);
app_runtime has **no** CREATE-on-database privilege.

## Dependencies added

None. pg-boss (Phase 2) unchanged. `vite-node` used for `npm run worker` already
ships with vitest (dev). No paid service, Redis, external search, AI, or app
dependency.

## Still REQUIRES VERIFICATION

- **Bulk-operation concurrency limit** per shop (historically 1; reportedly
  higher). We serialize per shop, so we are safe under any limit.
- **Numeric inventory** (`ProductVariant.inventoryQuantity`,
  `sellableOnlineQuantity`) needs `read_inventory`; not synced. The availability
  fields we DO sync sit on the Product/ProductVariant objects (read_products
  object scope); if a specific store finds them redacted, `read_inventory` would
  be required — flagged, not assumed.
- **`bulk_operations/finish`** webhook is still only acknowledged (we poll).

## Deviations

No new deviations from the approved Phase 0 architecture beyond those recorded in
`docs/PHASE2.md §12`. The Phase 1 tenant model is preserved and app_runtime is
now stricter (no CREATE-on-database).

---

**PHASE 2.1 COMPLETE. PHASE 3 NOT STARTED. AWAITING APPROVAL.**
