# Phase 4 Report — Filters & Facets

Date: 2026-09-29. Built on the Phase 3 search engine, pg-verified (identical SQL
via node-postgres). Per rule 4.7 the closing "PHASE 4 COMPLETE" line is withheld
until the live GitHub Actions run confirms the Prisma path — the workflow is
extended and ready; you push + trigger it (I cannot push from this sandbox).

> STATUS: implemented + pg-verified in the sandbox. **Live-Prisma confirmation
> pending** (extend-and-run `.github/workflows/live-prisma-check.yml`). Phase 5
> not started.

## Requirement Preservation Check

No approved requirement/architecture changed. Global rules held: no Redis, no
external search engine, no AI/LLM/embeddings/pgvector, no paid SaaS, no other
Shopify app, **no new scope**. Scope narrowings honoured: "filter tree" =
collection-scoped filtering (no custom taxonomy); metafields = full faceting for
vendor/product_type/tags/price/availability **plus one** single-value exact-match
metafield facet as the extension point. No storefront/theme UI (Phase 7). No
ranking/synonym/typo changes (Phase 5). No performance claims.

## Implementation summary

- **4.1 Schema (migration 0007, additive).** Confirmed vs the scope note: Phase 3
  kept vendor/product_type/price_min/price_max only in the `doc` JSONB, **not** as
  columns. Phase 4 promotes them to indexed columns + adds `tags TEXT[]` and
  `metafields JSONB` (product + product_search_doc), all computed in the ONE
  shared `docInsertSql` (build / in-place refresh / activation catch-up) so
  facets never drift from search. GIN(tags, metafields) + btree(vendor,
  product_type, price). Metafield capture wired through bulk + incremental via the
  shared normalizer.
- **4.2 Facets** (`app/lib/search/facets.ts`): per-facet `GROUP BY` counts with
  the facet's own filter group EXCLUDED (so an option never zeroes its own facet),
  every other filter + text match + collection scope + visibility applied; price
  returned as a min/max range. Precise SQL in `docs/PHASE4.md §4.2`.
- **4.3 Filters** (`app/lib/search/filters.ts`): OR within a group, AND across
  groups; fully parameterised via a `Params` accumulator (no string-concatenated
  SQL); validated + capped → `FilterValidationError` → HTTP 400.
- **4.4 Collection scope**: member join, visibility preserved.
- **4.5 API + admin**: App Proxy `products` route returns
  `{products,total,facets,appliedFilters,priceRange,…}`; admin playground filter
  panel with live counts. Native-fallback contract reused for filter-path errors.
- **4.6/4.7 Tests**: 18 pg-verified Phase 4 tests + a Prisma-integration filtered
  case.

### Files

Created: `prisma/migrations/0007_phase4_filters/migration.sql`,
`app/lib/search/filters.ts`, `app/lib/search/facets.ts`,
`app/lib/search/params.ts`, `scripts/ci-enqueue-maintenance.mjs` (Phase 3),
`test/phase4-filters.test.ts`, `docs/PHASE4.md`.
Modified: `app/lib/search/config.ts` (FACET_METAFIELD), `app/lib/search/query.ts`
(shared builders + filters + browse mode), `app/lib/search/storefront.ts`
(facets + appliedFilters + priceRange), `app/lib/search/predictive.ts`
(empty-q guard), `app/lib/search/proxy.server.ts` (400 on invalid filters),
`app/lib/index/engine.ts` (facet columns in docInsertSql),
`app/lib/shopify/bulk.server.ts` + `app/lib/catalog/normalize.ts` +
`app/lib/catalog/store.ts` (metafield capture),
`app/routes/proxy.products.tsx`, `app/routes/app.search.tsx`, `app/routes/app.tsx`,
`test/prisma-integration.test.ts`, `docs/FEATURE_MATRIX.md`.

## Facet-counting algorithm (for your verification)

For each facet group F, one `GROUP BY count` query:
`WHERE visibility AND [collection scope] AND [text match of the winning stage]
AND (every active filter predicate EXCEPT F's own)`, grouped by F's value
(vendor / product_type / unnested tag / available / `metafields->>key`). Price is
`min(price_min), max(price_max)` over the set filtered by all groups except price.
The SAME `buildWhere` + resolved search `matcher` power both the product page and
every facet, so counts match results exactly. Full SQL and a worked example in
`docs/PHASE4.md`.

## Command outputs (sandbox)

```
npm test          → Test Files 19 passed (19)   Tests 125 passed | 4 skipped (129)
npm run typecheck → 0 errors
npm run build     → exit 0
npm run worker:build → worker bundled -> build/worker/run-worker.js
```

The 4 skips are `prisma-integration` (engine-gated; incl. the new Phase 4 case).
Phase 4 added 18 tests (`phase4-filters`). Migrations 0001→0007 apply cleanly to
a fresh database.

## Shopify docs verification

- Product metafields read under existing `read_products`; which metafields return
  depends on per-metafield access controls (REQUIRES VERIFICATION per store) — no
  new scope. Sources: Shopify Admin `Product` object; Metafields access &
  permissions.
- Bulk namespace-filtered `metafields` selection: verified only against a live
  store (REQUIRES VERIFICATION; trivial fallback if rejected).

## Known limitations / REQUIRES VERIFICATION

- Metafield type coverage is **partial by design** (one single-value exact-match
  facet; list/boolean/number/date/money not faceted).
- Metafield read access per store; bulk metafields selection live behaviour.
- Collection hierarchy: none native in Shopify — collection-scoped facets only;
  metafield-based category tree is a Phase-8 candidate (REQUIRES VERIFICATION).
- No performance targets asserted (Phase 14).

## Deviations

- vendor/product_type/price promoted from doc-JSONB to indexed columns (the
  "confirm, don't duplicate" note — they were NOT columns before; now materialised
  once in the shared docInsertSql).
- Price returned as a `priceRange {min,max}` rather than counted `options`
  (continuous range doesn't fit the option/count shape); availability is a counted
  facet.
- Empty `q` = browse-all (list visible + facets) to support collection/filter-only
  pages; predictive still returns nothing for empty `q`.

## 4.7 Live-Prisma confirmation — pending your push

`.github/workflows/live-prisma-check.yml` already runs the full suite (fails if
`prisma-integration` skips) + the real worker; the Prisma-integration suite now
includes the Phase 4 filtered-search + facet case. Push these Phase 4 changes and
run the workflow (Actions → Live Prisma Check → Run workflow), then send the run
URL. I will finalise this report with the live results and the closing line.

STATUS: PHASE 4 IMPLEMENTED & PG-VERIFIED. LIVE-PRISMA CONFIRMATION PENDING.
PHASE 5 NOT STARTED. AWAITING LIVE-PRISMA RUN AND EXPLICIT USER APPROVAL.
