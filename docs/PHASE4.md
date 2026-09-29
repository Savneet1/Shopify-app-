# Phase 4 — Filters & Facets

Filtering + faceting on top of the Phase 3 search engine: API + admin playground
only (no theme/storefront UI — that is Phase 7). Global rules unchanged (no
Redis, no external search engine, no AI, no paid SaaS, no other Shopify app, no
new scope). Reuses `.github/workflows/live-prisma-check.yml` for live-Prisma
confirmation.

## Scope (as narrowed by the approval)

- **"Filter tree" = collection-scoped filtering**, NOT a custom taxonomy.
  Shopify collections have no native parent/child hierarchy; when `collectionId`
  is passed, facets and results are computed only over that collection's member
  products. A metafield-based hierarchy is a **Phase-8 candidate — REQUIRES
  VERIFICATION**, not built here.
- **Metafields: fully faceted attributes are vendor, product_type, tags, price
  range, availability.** PLUS **one** proof-of-concept metafield facet
  (single-value, exact-match, configured namespace/key) as the extension point.
  Full metafield-type coverage (list / boolean / number_integer / date / money /
  …) is **out of scope** and does not block Phase 4.
- No ranking/synonyms/typo changes (Phase 5). No storefront UI (Phase 7).

## Shopify verification (2026-09-29)

- **No new scope.** Product metafields are read under the existing
  `read_products` resource scope. WHICH metafields are returned depends on each
  metafield's access controls (the 2024/2025 metafield privacy model): the
  merchant's own custom metafields are readable; another app's private metafields
  are not. This is a per-store **REQUIRES VERIFICATION** nuance — no scope is
  added, and the POC facet simply surfaces whatever is readable.
  Sources: [Product — GraphQL Admin](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product),
  [Metafields access & permissions](https://shopify.dev/docs/apps/build/custom-data/metafields/definitions/use-access-controls-metafields).
- The bulk `metafields(namespace: …)` selection (nested connection with a
  namespace argument in a Bulk Operation) is exercised only against a live store
  — **REQUIRES VERIFICATION**; the pg-verified tests inject catalog rows directly
  (same as Phases 2–3). If a store rejects the namespace-filtered bulk selection,
  the fix is to drop the argument and filter in the normalizer (no schema change).

## 4.1 Schema (migration 0007, additive)

Confirmed actual Phase-3 state: `vendor`, `product_type`, `price_min`,
`price_max` existed only inside the `product_search_doc.doc` JSONB — NOT as
columns. Phase 4 **promotes them to indexed columns** (still computed in the ONE
shared `docInsertSql`, so no second computation site and no drift):

- `product.metafields JSONB` — flat `{ "namespace.key": "value" }` map for the
  configured facet namespace.
- `product_search_doc`: `vendor TEXT`, `product_type TEXT`, `tags TEXT[]`,
  `price_min/price_max NUMERIC(12,2)`, `metafields JSONB`.
- Indexes: GIN on `tags` and on `metafields (jsonb_path_ops)`; btree on
  `(shop_id, index_version_id, vendor)`, `(…, product_type)`,
  `(…, price_min, price_max)`.

Capture path (both bulk and incremental, via the shared normalizer):
`bulk.server.ts` (`METAFIELD_FIELDS`) → `normalize.ts` (`toMetafields`, keeps
only the configured namespace and scalar values) → `store.ts` (`ProductInput.
metafields` + upsert) → `engine.ts docInsertSql` populates the facet columns.

Facet metafield config (`app/lib/search/config.ts`, env-overridable):
`FACET_METAFIELD = { namespace: "custom", key: "material", label: "Material" }`.

## 4.2 Facet counting — the precise algorithm

Each facet is computed by its OWN `GROUP BY count` query. The rule "counts
reflect all OTHER active filters, not the facet's own selection" is implemented
by building the WHERE with that facet's own filter group EXCLUDED.

Shared base predicate (identical to the product query, from `buildWhere`):

```
visibility            : shop_id = $ AND index_version_id = $ AND published = true AND status = 'ACTIVE'
[collection scope]    : product_id IN (SELECT pc.product_id FROM product_collection pc
                          JOIN collection col ON col.id = pc.collection_id
                          WHERE col.shop_id = $ AND col.shopify_collection_gid = $ AND col.deleted_at IS NULL)
[text match (winner)] : ((<fts predicate for the winning stage>) OR (<sku whole-token hit>))
filter predicates     : every active group EXCEPT the excluded one
```

Per facet:

- **vendor**: `… WHERE <base, exclude=vendor> AND vendor IS NOT NULL GROUP BY vendor`
- **product_type**: same with `product_type`, `exclude=productType`
- **tags**: `FROM product_search_doc psd, unnest(psd.tags) t WHERE <base, exclude=tags> GROUP BY t`
- **availability**: `… WHERE <base, exclude=available> GROUP BY available` → In stock / Out of stock
- **metafield**: `… WHERE <base, exclude=metafield> AND metafields->>$key IS NOT NULL GROUP BY metafields->>$key`
- **price range** (not a counted-options facet — a continuous range): `SELECT min(price_min), max(price_max) … WHERE <base, exclude=price>`

Because every facet shares the same `buildWhere` + the same resolved `matcher`
(winning search stage) as the product query, facet counts and results can never
diverge. Every user value is a bound parameter via the `Params` accumulator —
there is **no string-concatenated SQL** anywhere in the filter/facet path.

Worked example (catalog: Nike Shoe, Nike Sandal, Adidas Shoe, Puma Shoe):
selecting **vendor = Nike** narrows results to 2 products, but the vendor facet
(vendor excluded) still reports Nike 2 / Adidas 1 / Puma 1 — so the user can
switch vendor — while the product_type facet (vendor applied) reports Shoe 1 /
Sandal 1. Tested explicitly in `test/phase4-filters.test.ts`.

## 4.3 Filter application

`app/lib/search/filters.ts` parses, validates and caps input
(`normalizeFilters`), then builds parameterised predicates:

- vendor[] / productType[] / metafield[] : `col = ANY($::text[])` (OR within group)
- tags[] : `tags && $::text[]` (array overlap = OR within group)
- price : `price_max >= $min AND price_min <= $max` (range overlap)
- available : `available = $::boolean`
- collectionId : membership subquery (4.4)

**Within a group, values OR** (choices within one attribute broaden the set);
**across groups, AND** (choices across attributes narrow). This is conventional
faceted-navigation semantics and is documented in `filters.ts`.

Validation caps (malformed → `FilterValidationError` → **HTTP 400**, never 500):
≤ 50 values per group, ≤ 100 chars per value, price 0…1e9 with `priceMin ≤
priceMax`, `collectionId` ≤ 255 chars.

## 4.4 Collection-scoped filtering

`collectionId` is a Shopify collection GID; the scope predicate joins
`product_collection → collection` (visibility rule unchanged). Facets and results
are then computed only over that collection's members.

## 4.5 API + admin

- App Proxy `GET /apps/<subpath>/products` (`proxy.products.tsx`) accepts filter
  params (repeated or comma-separated) via `filtersFromSearchParams` and returns
  `{ products, total, facets: [{ key, label, options: [{ value, label, count }] }],
  appliedFilters, priceRange, strategy, indexVersion, tookMs, fallback, zeroResult,
  suggestions }`. Malformed filters → 400; other errors → native fallback (200),
  never a bare 500 (Phase 3 contract reused).
- Admin **Search playground** (`app/routes/app.search.tsx`) gains a filter panel
  with live facet counts; selecting options re-runs the same `storefrontSearch`.

Design note: **price** is returned as `priceRange {min,max}` (a continuous range
for a slider), not as counted `options`, because the `{value,count}` option shape
does not fit a continuous range. **availability** IS a counted facet.

Browse mode: an empty `q` (with or without filters) lists all visible products +
facets — the collection-page / filter-only case. Predictive search still returns
nothing for an empty query (it never browse-dumps the catalog).

## 4.6 / 4.7 Tests

`test/phase4-filters.test.ts` (18) — pg-verified (node-postgres, identical SQL to
production): browse mode; own-selection-doesn't-zero-itself; AND across groups;
OR within a group; tags overlap; price range; availability; the metafield facet +
filter; **collection-scoped** facets/results; **visibility (draft/unpublished
excluded) under every filter combination**; **query hardening** (oversized arrays,
negative/inverted price, over-long value → 400-class; injection attempts treated
as literal values, table intact); **ONE cross-shop test** (filters can't leak
another shop's facet values); **active-version-only under filtered queries**
(swap). `prisma-integration.test.ts` gains a Phase 4 filtered-search + facet case
through the real Prisma `withShopExec` (runs on CI, skips in the sandbox).

## Dependencies / scopes

- npm dependencies added: **none**.
- Shopify scopes added: **none** (metafields via existing `read_products`).
- No new PostgreSQL extensions (Phase 3's `pg_trgm`/`unaccent` unchanged).

## Known limitations / REQUIRES VERIFICATION

- **Metafield type coverage is partial by design** — one single-value,
  exact-match facet only. list/boolean/number/date/money and multi-value
  metafields are NOT faceted (a later phase / extension point).
- **Metafield read access** depends on per-metafield access controls under
  `read_products` (REQUIRES VERIFICATION per store); the bulk namespace-filtered
  metafields selection is verified only against a live store.
- **Collection hierarchy**: none native in Shopify; Phase 4 does collection-scoped
  facets only. A metafield-driven category tree is a Phase-8 candidate (REQUIRES
  VERIFICATION).
- No performance targets claimed (Phase 14); the facet indexes exist and are used
  where the planner deems them cheapest.
