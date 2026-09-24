# Feature Matrix v1

Status legend: **Implemented** (built + tested in Phase 1) · **Planned** (owned by
a later phase; preserved, not built) · **Requires Verification** · **Blocked by
Shopify**. Implementation classes: FULLY IMPLEMENTABLE, PARTIALLY IMPLEMENTABLE,
APPROXIMATION, BLOCKED BY SHOPIFY, REQUIRES VERIFICATION.

Columns not shown per-row to keep this readable are constant for Phase 1 rows:
Third-party dependency = **none** (no external SaaS/AI); Storefront component =
n/a (no theme extension in Phase 1). Evidence = the file paths listed + the test
suite in `test/` (30 tests passing).

## Phase 1 — Foundation (Implemented)

| ID | Feature | Status | Class | Shopify dep | DB | Tests | Location |
|---|---|---|---|---|---|---|---|
| F1.1 | Project scaffold (React Router template) | Implemented | FULLY | CLI 4.x / RR template | – | typecheck | `package.json`, `vite.config.ts`, `react-router.config.ts`, `app/root.tsx`, `app/entry.server.tsx` |
| F1.2 | Managed install / token-exchange auth | Implemented | FULLY | Managed install | `session` | manual (`shopify app dev`) | `app/shopify.server.ts`, `app/routes/auth.$.tsx` |
| F1.3 | Embedded shell (App Bridge + Polaris web components) | Implemented | FULLY | App Bridge, Polaris WC | – | typecheck | `app/routes/app.tsx`, `app/routes/app._index.tsx` |
| F1.4 | Minimal scopes (`scopes = ""`) | Implemented | FULLY | Managed install | – | config | `shopify.app.toml` |
| F1.5 | PostgreSQL schema v1 (foundation tables) | Implemented | FULLY | – | all foundation tables | DB tests | `prisma/schema.prisma`, `prisma/migrations/0001_init` |
| F1.6 | Multi-tenancy (`shop_id` on every tenant table) | Implemented | FULLY | – | all tenant tables | DB tests | `prisma/schema.prisma` |
| F1.7 | Row-Level Security (+FORCE) | Implemented | FULLY | – | policies | `database-rls.test.ts` | `prisma/migrations/0002_rls_roles` |
| F1.8 | Non-SUPERUSER / non-BYPASSRLS runtime role | Implemented | FULLY | – | roles | `database-rls.test.ts` | `prisma/roles.sql`, `0002_rls_roles` |
| F1.9 | `withShop()` + `SET LOCAL app.shop_id` | Implemented | FULLY | – | – | `tenant-withshop.test.ts`, `database-rls.test.ts` | `app/lib/tenant.server.ts`, `app/lib/sql.server.ts` |
| F1.10 | Server-side tenant identity (never trust client) | Implemented | FULLY | Session | – | `tenant-withshop.test.ts` | `app/lib/tenant.server.ts`, `app/routes/app.tsx` |
| F1.11 | Privacy webhooks (data_request/redact/shop_redact) | Implemented | FULLY | Compliance webhooks | `data_deletion_request` | `webhook-*` tests | `app/routes/webhooks.compliance.tsx`, `app/lib/webhooks/compliance.server.ts` |
| F1.12 | `app/uninstalled` + `app/scopes_update` | Implemented | FULLY | Webhooks | `shop`,`session` | (handlers) | `app/routes/webhooks.app.*.tsx` |
| F1.13 | Webhook HMAC verification | Implemented | FULLY | Webhooks | – | `webhook-hmac.test.ts` | `app/lib/webhooks/hmac.server.ts` |
| F1.14 | Webhook idempotency / receipts | Implemented | FULLY | – | `webhook_receipt` | `webhook-idempotency.test.ts` | `app/lib/webhooks/receipt.server.ts` |
| F1.15 | Billing abstraction (provider-agnostic stub) | Implemented | PARTIALLY (stub) | Shopify Billing (later) | `billing_subscription` | `billing.test.ts` | `app/lib/billing/*` |
| F1.16 | Email abstraction (no-op) | Implemented | PARTIALLY (stub) | – | – | – | `app/lib/email/*` |
| F1.17 | Env validation (Zod) + structured logging (Pino, redaction) | Implemented | FULLY | – | – | (used) | `app/lib/env.server.ts`, `app/lib/logger.server.ts` |
| F1.18 | Feature Matrix v1 + docs | Implemented | FULLY | – | – | – | `docs/*` |

## Phase 2 — Sync & Versioned Index (Implemented)

| ID | Feature | Status | Class | Shopify dep | DB | Tests | Location |
|---|---|---|---|---|---|---|---|
| F2.1 | Catalog model (product/variant/collection/membership/metafield) | Implemented | FULLY | read_products | catalog tables | `catalog-store.test.ts` | `app/lib/catalog/store.ts`, migration 0003 |
| F2.2 | Bulk Operations full sync + JSONL parse (`__parentId`) | Implemented | FULLY | Bulk Operations | catalog tables | `sync-orchestrator.test.ts` | `app/lib/shopify/bulk.server.ts`, `app/lib/catalog/bulk-parse.ts` |
| F2.3 | Incremental sync via catalog webhooks | Implemented | FULLY | products/collections webhooks | catalog tables | `webhook-map.test.ts`, `sync-orchestrator.test.ts` | `app/lib/catalog/webhook-map.ts`, `app/routes/webhooks.catalog.tsx` |
| F2.4 | Versioned index: build → validate → **atomic swap** → rollback | Implemented | FULLY | – | `index_version`,`product_search_doc`,`index_consistency_check` | `index-versioning.test.ts` | `app/lib/index/engine.ts` |
| F2.5 | Interrupted-build recovery (active index untouched) | Implemented | FULLY | – | `index_version` | `index-versioning.test.ts` | `app/lib/index/engine.ts` |
| F2.6 | Incremental in-place active-index refresh | Implemented | FULLY | – | `product_search_doc` | `sync-orchestrator.test.ts` | `app/lib/index/engine.ts` |
| F2.7 | pg-boss jobs: retry/backoff, dead-letter, dedup, idempotency, tenant ownership, recovery | Implemented | FULLY | – | `job_audit`,`sync_run`,`sync_failure` | `jobs-idempotency.test.ts`, `jobs-pgboss.integration.test.ts` | `app/lib/jobs/*`, `app/lib/sync/store.ts` |
| F2.8 | Sync status dashboard + trigger | Implemented | FULLY | – | `sync_run`,`index_version` | (loader/action) | `app/routes/app.sync.tsx` |
| F2.9 | `bulk_operations/finish` webhook (ack) | Implemented | PARTIALLY | bulk_operations/finish | – | – | `app/routes/webhooks.bulk-operations-finish.tsx` |

Third-party services introduced in Phase 2: **none** (pg-boss is an OSS library,
not a service). Scope added: **read_products** only.

### Phase 2.1 hardening (see docs/PHASE2_1.md)

| ID | Item | Status | Notes |
|---|---|---|---|
| H1 | Monotonic upsert (out-of-order / no resurrection) | Implemented | `phase2-hardening.test.ts` P1/P2 |
| H2 | Variant + full-snapshot reconciliation + large-deletion safety | Implemented | P3/P4; `sync_run.stats/warning` |
| H3 | Build/swap catch-up (no lost updates) | Implemented | P5/P5b; `index_version.snapshot_at` |
| H4 | Re-fetch-by-GID incremental (shared normalizer) | Implemented | P6; `normalize.ts`, `fetch*Node` |
| H5 | Per-shop serialization (singleton + DB running-guard) | Implemented | `sync-serialization.test.ts` |
| H6 | Bulk client: poll-by-id + true product count | Implemented | `bulk.server.ts`; snapshot-count validation |
| H7 | Worker runtime lifecycle (start/process/SIGTERM) | Verified via worker:smoke | pg-boss path proven; the Prisma-backed `npm run worker` runs + connects but needs `prisma generate` (engine) — not runnable in the egress-blocked sandbox; deployable bundle built (`worker:build`) |
| H8 | pg-boss least privilege (owner-install, migrate:false) | Implemented | no `CREATE ON DATABASE` |
| H9 | Dashboard DLQ/failure visibility + ownership-verified retry | Implemented | `status.server.ts`, `app.sync.tsx` |
| H10 | Uninstall/redact job purge; drop jobs for removed shops | Implemented | `purge.server.ts`, `isShopInstalled` |
| H11 | Inventory availability fields (read_products) | Implemented | totalInventory, tracksInventory, availableForSale (numeric qty deferred) |
| H12 | Prisma casts + chunked/tenant-bound full sync | Implemented (code); Prisma execution unverified here | Casts + chunking implemented and pg-verified; the real Prisma `withShopExec` path is exercised only on an engine-enabled machine (prisma-integration test SKIPS in this sandbox) |

## Phase 3 — Search & Discovery (Implemented; Prisma execution pg-verified)

Third-party services introduced: **none**. Scopes added: **none** (result-card +
publication fields are `read_products`). Extensions enabled: `pg_trgm`,
`unaccent` (both TRUSTED contrib, no egress). See `docs/PHASE3.md`.

| ID | Feature | Status | Class | Shopify dep | Tests | Location |
|---|---|---|---|---|---|---|
| F3.1 | Result-card + publication data (image, price/compare-at, url, availability) | Implemented | FULLY | read_products | `phase3-search` | migration 0006, `bulk.server.ts`, `normalize.ts`, `store.ts` |
| F3.2 | Weighted tsvector (A–D) + `pg_trgm`/`unaccent`, GIN indexes, shared `docInsertSql` | Implemented | FULLY | – | `phase3-search`, `phase3-index-usage` | migration 0006, `search/config.ts`, `index/engine.ts` |
| F3.3 | Query engine: ACTIVE-only, sanitised tsqueries, strategy cascade, exact-SKU-first, `ts_rank_cd` | Implemented | FULLY | – | `phase3-search` (21) | `app/lib/search/query.ts` |
| F3.4 | Predictive search + catalog-derived suggestions (no popularity) | Implemented | FULLY | – | `phase3-search` | `search/predictive.ts`, `search/suggest.ts` |
| F3.5 | Zero-result structured block + degraded-mode native fallback (never 500) | Implemented | FULLY | – | `phase3-search` | `search/storefront.ts` |
| F3.6 | App Proxy JSON API (search/predictive/suggest); signature-verified shop; Redis-free per-shop rate limit | Implemented | FULLY | App Proxy | `phase3-appproxy` (8) | `shopify.app.toml` `[app_proxy]`, `routes/proxy.*.tsx`, `search/proxy.server.ts`, `search/rate-limit.ts` |
| F3.7 | Admin Search playground (`/app/search`), session-authenticated | Implemented | FULLY | Session | (loader) | `app/routes/app.search.tsx`, nav in `app.tsx` |
| F3.8 | Tests: relevance, exclusion, versioning, incremental, fallback, predictive/suggest, App Proxy security + cross-shop, hardening, EXPLAIN | Implemented | FULLY | – | 30 Phase 3 tests | `test/phase3-*.test.ts` |

Prisma-execution note: the Phase 3 search/predictive/suggest/proxy code runs
through the production Prisma `withShopExec`; that execution is **pg-verified
(identical SQL via node-postgres), NOT yet confirmed on a live Prisma engine** in
this sandbox (engine egress-blocked) — same constraint as Phase 2.1 H12 / G1 /
G3. The `prisma-integration` suite (incl. a Phase 3 search case) RUNS on an
engine-enabled machine and SKIPS here.

## Later phases (Planned — preserved, not implemented)

| ID | Area | Status | Phase | Notes / class |
|---|---|---|---|---|
| F4 | Filters, filter trees, metafields, counts, collection filtering | Planned | 4 | Theme-dependent result replacement = **Requires Verification** (Phase 7). |
| F5 | Typo tolerance, synonyms, stop words, redirects, ranking, benchmarks | Planned | 5 | Damerau-Levenshtein, rule-based. |
| F6 | Semantic layer / natural-language parser | Planned | 6 | Rule-based only (no AI/embeddings/pgvector). |
| F7 | Theme App Extension, mobile, URL state, a11y, Dawn + 2 themes, vintage investigation | Planned | 7 | Progressive enhancement; native search must survive app outage. |
| F8 | Merchandising (pin/boost/demote/hide/banners/schedule) + A/B testing | Planned | 8 | FULLY. |
| F9 | Recommendations (similar/related/FBT/trending/…); personalization | Planned | 9 | Own algorithms + PostgreSQL. `read_orders`/protected data = **Requires Verification**. |
| F10 | Bundles | Planned | 10 | Certain bundle discounts require **Shopify Functions** — Requires Verification. |
| F11 | Analytics (partitioned `analytics_event`, typed views, CSV), Web Pixel, attribution | Planned | 11 | No IP storage; Web Pixel sandbox/consent = Requires Verification. |
| F12 | Back-in-stock, pre-order, countdown, email delivery | Planned | 12 | Email provider-agnostic; pre-order/checkout limits = Requires Verification. |
| F13 | Markets, i18n, B2B, Combined Listings | Planned | 13 | Plan/availability dependent = Requires Verification. |
| F14 | Performance, security hardening, large catalog | Planned | 14 | Targets (predictive ≤60ms p95@100k; search+facets ≤250ms@100k / ≤150ms@10k; typo ≤+30ms) — **not measured yet; do not claim as met**. |
| F15 | Full parity audit, bug-fix, docs | Planned | 15 | – |

## Known Shopify limitation areas (carried forward — Requires Verification)

Protected customer/order data & `read_all_orders`; Shopify Functions for bundle
discounts; pre-order/checkout customization limits; theme-dependent search/
result & collection replacement; Web Pixel sandbox/consent; App Proxy behavior/
latency; B2B plan dependency; Combined Listings availability; Markets/multi-
currency; email delivery infrastructure. None are marked "fully supported"
without verification in their owning phase.
