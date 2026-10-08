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

## Phase 4 — Filters & Facets (Implemented; Prisma execution pg-verified)

Third-party services: **none**. Scopes added: **none** (metafields via existing
`read_products`). See `docs/PHASE4.md`.

| ID | Feature | Status | Class | Shopify dep | Tests | Location |
|---|---|---|---|---|---|---|
| F4.1 | Facet columns materialised on `product_search_doc` (vendor, product_type, tags[], price_min/max, metafields) via shared `docInsertSql` | Implemented | FULLY | read_products | `phase4-filters` | migration 0007, `index/engine.ts`, `bulk.server.ts`, `normalize.ts`, `store.ts` |
| F4.2 | Facet counting (own-selection-excluded; per-facet GROUP BY; price range) | Implemented | FULLY | – | `phase4-filters` | `app/lib/search/facets.ts` |
| F4.3 | Filter application (vendor/type/tags/price/availability/metafield; OR-in-group, AND-across; validated → 400) | Implemented | FULLY | – | `phase4-filters` | `app/lib/search/filters.ts`, `query.ts` |
| F4.4 | Collection-scoped filtering (member join; visibility preserved) | Implemented | FULLY | – | `phase4-filters` | `filters.ts` (`collectionPredicate`) |
| F4.5 | App Proxy filter params + `{facets, appliedFilters, priceRange}`; admin filter panel | Implemented | FULLY | App Proxy | (route/loader) | `routes/proxy.products.tsx`, `routes/app.search.tsx`, `search/params.ts` |
| F4.6 | One metafield facet (single-value exact-match) — extension point | Implemented | PARTIALLY (by design) | read_products | `phase4-filters` | `config.ts` `FACET_METAFIELD` |
| F4.7 | Tests: facet correctness, AND-combine, collection scope, visibility-under-filters, hardening, cross-shop, active-version | Implemented | FULLY | – | 18 `phase4-filters` + prisma-integration case | `test/phase4-*.test.ts` |

Requires Verification (Phase 4): metafield read access per store under
`read_products`; bulk namespace-filtered metafields selection on a live store;
full metafield-type coverage (out of scope); collection hierarchy (none native —
Phase-8 candidate). Storefront/theme result replacement remains **Phase 7**.

Prisma-execution note: the filter/facet code runs through the production Prisma
`withShopExec`; that execution is pg-verified (identical SQL via node-postgres)
and confirmed live on GitHub Actions (see the Phase 4 report).

## Phase 5 — Search Relevance (Implemented; Prisma execution pg-verified)

Third-party services: **none**. Scopes added: **none**. Extensions added:
**none** (pg_trgm reused; Damerau-Levenshtein in TypeScript). See `docs/PHASE5.md`.

| ID | Feature | Status | Class | Tests | Location |
|---|---|---|---|---|---|
| F5.1 | Typo tolerance (Damerau-Levenshtein + pg_trgm candidates; per-version vocabulary; length thresholds; numeric/SKU exclusion; correction indicator) | Implemented | FULLY | `phase5-units`, `phase5-relevance` | `damerau.ts`, `text.ts`, `vocabulary.ts`, `rewrite.ts`, migration 0008 |
| F5.2 | Synonyms (per-shop, one/two-way, multi-word, query-time, caps) | Implemented | FULLY | `phase5-*` | `synonyms.ts`, `app/routes/app.synonyms.tsx` |
| F5.3 | Stop words (default + per-shop overrides; all-stop fallback; applied to search/predictive/facets) | Implemented | FULLY | `phase5-*` | `stopwords.ts`, `app/routes/app.stopwords.tsx` |
| F5.4 | Redirects (normalized exact match; open-redirect protection; payload not 30x) | Implemented | FULLY | `phase5-*` | `redirects.ts`, `app/routes/app.redirects.tsx` |
| F5.5 | Rule-based ranking (match class > field weights > in-stock > tie-break; deterministic; explanation) | Implemented | FULLY | `phase5-relevance` | `ranking.ts`, `query.ts`, `match.ts` |
| F5.6 | Admin CRUD UI + playground (corrections/redirects/ranking explanation) | Implemented | FULLY | (loaders) | `app/routes/app.{synonyms,stopwords,redirects,search}.tsx` |

New tenant tables (RLS enabled+forced, app_runtime grants): `search_vocabulary`,
`search_synonym`, `search_stopword`, `search_redirect` (migration 0008).
Benchmarks/performance remain **Phase 14** (no numbers claimed).

## Phase 6 — Semantic Layer / NL Query Parser (Implemented; Prisma execution pg-verified)

Third-party services: **none**. Scopes added: **none**. Extensions added:
**none**. Rule-based + deterministic. See `docs/PHASE6.md`.

| ID | Feature | Status | Class | Tests | Location |
|---|---|---|---|---|---|
| F6.1 | Intent extraction (price under/over/between/around + currency; availability; brand→vendor; type→product_type; attributes; sort cheapest/newest) | Implemented | FULLY | `phase6-units`, `phase6-nl` | `nlparse.ts` |
| F6.2 | Per-shop attribute dictionary (term→facet) + English defaults + admin CRUD | Implemented | FULLY | `phase6-*` | `attributes.ts`, `app/routes/app.attributes.tsx`, migration 0009 |
| F6.3 | Parsed intent → existing filters + plan; remaining = free text | Implemented | FULLY | `phase6-nl` | `storefront.ts` (`mergeRawFilters`, `runCore`) |
| F6.4 | Transparency (`interpretedAs`), per-request `nl` disable + `ignore`, zero-result fallback (never worse than Phase 5) | Implemented | FULLY | `phase6-nl` | `storefront.ts`, `proxy.products.tsx`, `app.search.tsx` |
| F6.5 | Safety (same validation; bounded input; deterministic; hostile-input tests; negation degrades safely) | Implemented | FULLY | `phase6-units`, `phase6-nl` | `nlparse.ts`, `filters.ts` |
| F6.6 | Sort hints + `product.createdAt` capture → `created_at_shopify` in docInsertSql | Implemented | FULLY | `phase6-nl` | `query.ts`, `engine.ts`, migration 0009 |

New tenant table (RLS enabled+forced, app_runtime grants): `search_attribute_term`
(migration 0009). Negative filtering is intentionally unsupported (negation
degrades safely). Benchmarks remain **Phase 14**.

## Phase 6.1 — NL parser fix batch (Implemented; Prisma execution pg-verified)

Third-party services: **none**. Scopes added: **none**. npm deps added:
**none**. PostgreSQL extensions added: **none**. Migrations added: **none**.
Rule-based + deterministic. See `docs/PHASE6_1.md`.

| ID | Fix | Status | Class | Tests | Location |
|---|---|---|---|---|---|
| A1 | Price parsing: thousands commas (`under $1,000`→1000); reject (not truncate) >9 integer digits / >2 decimals; fix `~` cue; `between 10-50` (hyphen/en-dash, no spaces); unit/count words (`ml`,`kg`,`colors`,`stars`,`18s`…) are not prices; ambiguous cues (`from`/`over`/`above`/`at least`/`more than`/`up to`) skip plausible years (1900–2100) unless a currency marker is present | Implemented | FULLY | `phase6-units` (A1 block) | `nlparse.ts` (`amountInfo`, `notAPrice`, `extractPrice`) |
| A2 | Tag/metafield attribute values (defaults + per-shop dictionary) resolve case-insensitively against LIVE visible facet values and apply the live casing; no live match ⇒ not applied (stays free text); no draft leakage; per-shop isolated | Implemented | FULLY | `phase6_1` (A2) | `nlparse.ts` (`buildParseContext` live tag/metafield values, `ciMap`, `applyEntry`) |
| A3 | Negation transparency: `interpretedAs.negationIgnored` + human-readable `warning`; playground shows the warning | Implemented | FULLY | `phase6_1` (A3) | `storefront.ts` (`InterpretedAs`, `negationWarning`), `app/routes/app.search.tsx` |
| A4 | Strip C0 control chars (incl. NUL `0x00`) from `q` and free-text filter values in the SHARED normalization path — a NUL can no longer reach SQL (nl on or off) | Implemented | FULLY | `phase6_1` (A4) | `text.ts` (`stripControl`), `query.ts`, `filters.ts` |

No migration, no schema change, no new indexed field: `docInsertSql` remains the
single source of truth. One query planner still drives search and facets.
Benchmarks remain **Phase 14**.

## Phase 6.1b — NL parser follow-up fixes (Implemented; Prisma execution pg-verified)

Third-party services / scopes / deps / extensions / migrations added: **none**.
Rule-based + deterministic. See `docs/PHASE6_1.md` §"Phase 6.1b".

| ID | Fix | Status | Class | Tests | Location |
|---|---|---|---|---|---|
| B1 | Mixed-case duplicate facet values: resolve lower-case → **all** live casings (tags, metafield, vendor, product_type) and apply all (OR-within-group), so `"red"` finds products tagged `red`/`Red`/`RED`. Live-visible only; no draft leakage; per-shop isolated; deterministic | Implemented | FULLY | `phase6_1` (B1) | `nlparse.ts` (`ciMapMulti`, `buildParseContext`, `applyEntry`) |
| B2 | Malformed thousands grouping: accept commas only in proper 1–3 then groups-of-3; `under 1,00` / `under 1,0000` → no price, text unchanged; `under $1,000`/`under 1000` → 1000 | Implemented | FULLY | `phase6-units` (B2) | `nlparse.ts` (`extractPrice` boundary check) |
| B3 | Ambiguous cues (`from over above at least more than up to`) without a currency marker apply only if the number is the last token, or is followed by a currency word or a recognised vendor/type/attribute phrase; else ignored. Unambiguous cues unchanged | Implemented | FULLY | `phase6-units` (B3) | `nlparse.ts` (`notAPrice`, `knownFirstTokens`) |

Still no migration, schema change, or new indexed field. Benchmarks remain
**Phase 14**.

## Phase 7 — Storefront / Theme App Extension (Implemented; live store/theme = Requires Verification)

Third-party services / scopes / deps / extensions / migrations added: **none**.
Docs verification: `docs/PHASE7.md`. Theme compat: `docs/PHASE7_THEME_COMPAT.md`.
Report: `docs/PHASE7_REPORT.md`.

| ID | Feature | Status | Class | Tests | Location |
|---|---|---|---|---|---|
| F7.0 | Shopify docs verification (TAE, OS2.0 JSON templates, app proxy from JS, `/search`, vintage limits) with Verified/Requires-Verification marks | Implemented | docs | — | `docs/PHASE7.md` |
| F7.1 | Theme app extension: app embed (predictive) + search-results app block (grid/facets/sort/pagination/interpreted-as chips w/ remove/typo indicator/negation warning/zero-result suggestions/redirect); settings schema; locales en+fr + parity script | Implemented | FULLY (logic) / Requires Verification (live theme) | `phase7-core` | `extensions/search-discovery-theme/*`, `scripts/check-locale-parity.mjs` |
| F7.2 | Storefront JS: proxy-only, AbortController ~2s timeout + native fallback, additive/no-framework/no-dep | Implemented | FULLY (logic) / RV (DOM) | `phase7-core` | `assets/boost-core.js`, `boost-predictive.js`, `boost-results.js` |
| F7.3 | URL state (q/filters/sort/page/nl/ignore), shareable, back/forward, bounded+validated | Implemented | FULLY | `phase7-core` | `boost-core.js` (parse/serialize) |
| F7.4 | Mobile: responsive grid, filter drawer, ≥44px targets, no horizontal scroll | Implemented | RV (DOM) | — | `assets/boost.css`, `boost-results.js` |
| F7.5 | Accessibility WCAG 2.1 AA: ARIA combobox, keyboard, live region, focus mgmt, reduced-motion, no color-only meaning | Implemented | FULLY (logic) / RV (AT) | `phase7-core` | `boost-core.js` (comboboxKey), `boost-*.js`, `boost.css` |
| F7.6 | Security: textContent-only rendering, same-origin URL validation, CSP-friendly, no secrets/PII | Implemented | FULLY (logic) | `phase7-core` | `boost-core.js` (isSafeUrl), glue |
| F7.7 | Theme compat: Dawn + Refresh + Craft selector defaults; vintage investigation + manual install | Implemented | RV (live theme) | — | `docs/PHASE7_THEME_COMPAT.md` |
| F7.8 | Admin install/status page: deep links + index/proxy status check; no new scope | Implemented | FULLY (status) / RV (deep link live) | — | `app/routes/app.storefront.tsx` |
| F7.9 | Tests (node, no DOM dep): URL state incl. hostile, ARIA/keyboard, escaping+URL validation, timeout→fallback, locale parity, extension schema/liquid static checks | Implemented | FULLY | `phase7-core` | `test/phase7-core.test.ts` |

Correction: `app/routes.ts` (explicit table) now registers the App Proxy
endpoints and the Phase 3–6 admin pages (previously present but unregistered),
plus the new `app.storefront` page — wiring only, no new feature/scope. DOM,
live-store, live-theme and deep-link behaviors are **Requires Verification**.
Benchmarks remain **Phase 14**.

## Phase 8 — Merchandising + A/B testing (Implemented; Prisma execution pg-verified)

Third-party services / scopes / deps / extensions added: **none**. Migration
`0010_phase8_merchandising` (5 tenant tables, RLS enabled+forced). Applied inside
the one query planner. Docs: `docs/PHASE8.md`, report `docs/PHASE8_REPORT.md`.

| ID | Feature | Status | Class | Tests | Location |
|---|---|---|---|---|---|
| F8.1 | Rules pin/boost/demote/hide; scope query_exact/contains/collection/global; priority + conflict resolution (hide>pin>boost>demote, then priority, then id); caps; pins stable across pagination; boost/demote bounded (≤90, never crosses match class); hide = hard WHERE; relevance-only for pin/boost/demote | Implemented | FULLY | `phase8-merch`, `phase8-units` | `app/lib/merch/rules.ts`, `match.ts`, `query.ts`, migration 0010 |
| F8.2 | Scheduling: start/end (UTC + IANA tz for display), SQL active-window with a single `now`, start-inclusive/end-exclusive | Implemented | FULLY | `phase8-merch` (injected clock) | `rules.ts`, migration 0010 |
| F8.3 | Banners (per query/collection, scheduled); allowlisted https image + same-site link + bounded text; payload + storefront render (textContent) + toggle | Implemented | FULLY (logic) / RV (live theme) | `phase8-merch`, `phase8-units` | `app/lib/merch/banners.ts`, `storefront.ts`, extension |
| F8.4 | Admin CRUD (rules/banners/experiments) + schedule editor + "why is this here?" in the playground + exposure report; routes registered + routing-guard-covered | Implemented | FULLY | routing guard | `app/routes/app.merch.tsx`, `app.banners.tsx`, `app.experiments.tsx`, `app.search.tsx` |
| F8.5 | A/B: experiments (draft/running/stopped), split, 2 variants = rule sets ± bounded weight override; deterministic hash assignment; no token=control; aggregate exposure/click only; stop restores default; no significance | Implemented | FULLY (assignment+exposure) / RV (consent) | `phase8-units`, `phase8-merch` | `app/lib/merch/assign.ts`, `experiments.ts`, `proxy.merch-event.tsx`, extension |
| F8.6 | Invariants: results==facets under hide, RLS + cross-shop isolation, hostile inputs, determinism, no-rules baseline == Phase 6.1b | Implemented | FULLY | `phase8-merch` | — |

Consent gating (Shopify customer-privacy API), live beacons, deep-link flows and
conversion/revenue/significance (Phase 11) are **Requires Verification**.
Benchmarks remain **Phase 14**.

## Later phases (Planned — preserved, not implemented)

| ID | Area | Status | Phase | Notes / class |
|---|---|---|---|---|
| F7 | Theme App Extension, mobile, URL state, a11y, Dawn + 2 themes, vintage investigation | **Implemented** | 7 | See the Phase 7 section above. Progressive enhancement; native search survives app outage. Live store/theme = Requires Verification. |
| F8 | Merchandising (pin/boost/demote/hide/banners/schedule) + A/B testing | **Implemented** | 8 | See the Phase 8 section above. Inside the one planner; aggregate-only A/B; consent gating = Requires Verification. |
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
