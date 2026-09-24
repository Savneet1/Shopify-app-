# Phase 3 — Search & Discovery (FTS)

Storefront full-text search over the ACTIVE index version, a tenant-safe App
Proxy JSON API, predictive search, catalog-derived suggestions, a zero-result /
degraded-mode fallback, and an embedded admin "Search playground".

Built strictly per the approved Phase 0 Rev 2 architecture and the Phase 3 scope.
Global rules unchanged: **no Redis, no external search engine, no AI/LLM/
embeddings/pgvector, no paid SaaS, no other Shopify app dependency, no new
Shopify scope.**

## Scope boundary (what Phase 3 is, and is NOT)

IN: FTS over the active index (PostgreSQL FTS + `pg_trgm` + `unaccent`); result
cards; App Proxy storefront JSON API; predictive search; catalog-derived
suggestions; zero-result/degraded fallback; admin Search playground.

OUT (owned by later phases, deliberately not built): filters/facets/counts/sort
beyond relevance (Phase 4); typo tolerance / synonyms / stop-words / redirects /
ranking tuning / benchmarks (Phase 5); NL/semantic (Phase 6); theme extension /
storefront widgets (Phase 7); merchandising (8); recommendations (9); bundles
(10); analytics / query logging (11).

`pg_trgm` is used ONLY for (a) prefix/substring acceleration and (b) the
last-resort zero-result fallback (word-similar title). It is **not** typo
tolerance — that (Damerau-Levenshtein, synonyms, stop words, redirects, ranking
tuning) is Phase 5. Search queries are **not** logged beyond minimal, PII-free
operational logs (no query text) — query analytics is Phase 11.

## Shopify verification (2026-09-22)

- **No new scope.** Result-card + publication fields — `product.onlineStoreUrl`,
  `product.featuredImage { url, altText }`, `variant.compareAtPrice` — are all
  readable under the existing `read_products` object scope. `onlineStoreUrl` is
  `null` when a product is **not** published to the Online Store sales channel;
  we use it as the publication signal, so no `read_publications` scope is needed.
  (Had a new scope been required, the rule is STOP and ask — it was not.)
- **Product status** enum is `ACTIVE` / `ARCHIVED` / `DRAFT`. Storefront search
  returns a product only when `status = 'ACTIVE'` **AND** it is published to the
  Online Store (`online_store_url IS NOT NULL`). Draft, archived, and
  unpublished products can never appear in storefront results (tested).
- **App Proxy** auth: `authenticate.public.appProxy(request)` verifies the
  Shopify proxy signature and throws a 400 on an invalid/absent signature. The
  shop is taken from the signature-verified session (`session.shop`), never a
  raw `?shop` query param — a tampered `?shop` invalidates the signature.
  Verified against `@shopify/shopify-api` v15 `validateHmac(..., {signator:
  'appProxy'})` (see `test/phase3-appproxy.test.ts`).

## Dependencies

**No new npm dependencies.** Two PostgreSQL extensions are enabled by the
migration, both TRUSTED (installable by the non-superuser database owner since
PG13) and both available on managed Postgres (RDS / Cloud SQL / Azure):

| Extension | Purpose | License | Account / egress |
|---|---|---|---|
| `pg_trgm` | trigram GIN indexes for prefix/substring acceleration + zero-result fallback | PostgreSQL (contrib) | none |
| `unaccent` | accent-folding text search dictionary | PostgreSQL (contrib) | none |

No external service, no data egress. If a managed provider disallows
`CREATE EXTENSION` for the app role, an admin enables both once.

## 3.1 / 3.2 — Search schema + result-card data (migration 0006)

`prisma/migrations/0006_phase3_search/migration.sql` (additive):

- **Extensions**: `pg_trgm`, `unaccent`.
- **`immutable_unaccent(text)`** — an IMMUTABLE, PARALLEL SAFE wrapper around
  `unaccent('public.unaccent', $1)`. Plain `unaccent()` is only STABLE and cannot
  be used in a stored/indexed expression; pinning the dictionary makes it
  IMMUTABLE so `to_tsvector(immutable_unaccent(...))` can be indexed. Verified:
  `'Café Crème' → 'Cafe Creme'`, `provolatile = 'i'`.
- **Result-card columns**: `product.featured_image_url`,
  `product.featured_image_alt`, `product.online_store_url`,
  `variant.compare_at_price`.
- **Search columns on `product_search_doc`**: `tsv tsvector`, `title`,
  `sku_text`, `status`, `published bool`, `available bool`.
- **Indexes**: `psd_tsv_gin` (GIN on `tsv`), `psd_title_trgm` /
  `psd_sku_trgm` (GIN `gin_trgm_ops`), `psd_filter`
  (`shop_id, index_version_id, published, status`).

**Weighted tsvector** (config in `app/lib/search/config.ts`, one place so later
phases change it once): **A** = title; **B** = vendor, product type, SKU +
barcode; **C** = tags, collection titles, variant titles; **D** = description —
all accent-folded via `immutable_unaccent` before `to_tsvector('english', …)`.

The tsvector, the searchable columns and the enriched result-card `doc` (image
`{url,alt}`, `priceMin`/`priceMax`, `compareAtMin`/`compareAtMax`, `handle`,
`url`, `available`) are all computed inside the **single shared `docInsertSql`**
in `app/lib/index/engine.ts`, so full build, in-place incremental refresh and
activation catch-up produce identical, searchable rows. `reindexVersionDocs()` /
`backfillActiveSearchColumns()` re-project pre-Phase-3 docs without a full
rebuild.

The result-card capture is wired through the whole sync path:
`bulk.server.ts` (PRODUCT_FIELDS/VARIANT_FIELDS) → `normalize.ts` →
`store.ts` (ProductInput/VariantInput + upserts), so both the bulk and the
incremental (re-fetch-by-GID) paths populate the new fields identically.

## 3.3 — Query engine (`app/lib/search/query.ts`)

- Reads **only** the shop's ACTIVE index version, and only
  `published = true AND status = 'ACTIVE'` docs.
- **Parameterised, sanitised tsqueries.** Full phrase → `websearch_to_tsquery`.
  Prefix / OR lexeme strings are assembled from `[\p{L}\p{N}]` tokens only, then
  fed to `to_tsquery` — the tsquery operators (`&`, `|`, `:*`) are the only
  special characters that can reach the parser, so user input can never break the
  query or inject. `immutable_unaccent` is applied to all query text.
- **Bounds**: query length capped (200 chars), `limit` clamped to ≤ 50, `offset`
  bounded, and `SET LOCAL statement_timeout` per request.
- **Strategy cascade**: `AND` (websearch) → `prefix` → `OR` → `trigram`
  (word-similar title, last resort). Exact SKU/barcode is OR-ed into every stage
  and always sorts first, so an exact code match is never lost and always leads;
  the label is `exact_sku` when only the code probe matched.
- **Relevance**: `ts_rank_cd` baseline (weights A–D), then `sku_hit` first,
  rank desc, title asc.
- **Response**: `{ products[], total, strategy, indexVersion, tookMs, fallback? }`.

## 3.4 — Predictive + catalog-derived suggestions

- `app/lib/search/predictive.ts`: a small, fast product page (same cascade, same
  visibility guarantees) **plus** catalog suggestions, in one tenant transaction.
- `app/lib/search/suggest.ts`: suggestions drawn from the CATALOG — product
  titles, vendors, product types, collection titles of visible products that
  begin with the typed prefix. Deterministic field-weight + shortest-first
  ordering. **Not** popularity/trending (that needs query analytics — Phase 11).

## 3.5 — Fallback / zero-result (`app/lib/search/storefront.ts`)

- `fallback: "native"` — the app cannot serve results (no active index yet,
  statement timeout, or DB error). The route still returns **HTTP 200** with this
  flag so the theme degrades to its own native search — never a bare 500.
- `zeroResult: true` — the index is healthy but nothing matched; a structured
  block with catalog-derived recovery suggestions is returned.

## 3.6 — App Proxy API

Routes (React Router loaders), JSON only:

| Storefront path | App route | Purpose |
|---|---|---|
| `/apps/search/products` | `proxy.products.tsx` | full search |
| `/apps/search/predictive` | `proxy.predictive.tsx` | predictive |
| `/apps/search/suggest` | `proxy.suggest.tsx` | suggestions |

`shopify.app.toml` `[app_proxy]` (`url = …/proxy`, `subpath = "search"`,
`prefix = "apps"`). `app/lib/search/proxy.server.ts` `handleProxy`:

1. `authenticate.public.appProxy` verifies the signature (invalid → 400
   propagates).
2. Shop = `session.shop` (signature-verified), never a raw `?shop`. `shopId`
   resolved server-side; every query runs under `withShop` (RLS) — one shop's
   request can only read its own catalog.
3. **Per-shop rate limiting without Redis** (`rate-limit.ts`): an in-process
   token bucket keyed by shop (default 30 burst, 10/s refill). Over-limit → 429
   with `Retry-After`.
   **Documented multi-instance limitation:** the bucket is per-process, so with N
   app instances the effective global limit is up to N × the per-instance limit.
   This is acceptable for Phase 3 (flood/abuse protection, not billing-grade
   quota); a strict global limit can move to a Postgres counter later.
4. JSON responses only (`application/json`, `Cache-Control: no-store`). Handler
   errors return `fallback: "native"` at HTTP 200 — never a bare 500. No query
   text is logged.

## 3.7 — Admin Search playground (`app/routes/app.search.tsx`)

Session-authenticated embedded page at `/app/search` (nav link added in
`app.tsx`). Runs the SAME `storefrontSearch` under the merchant's tenant context,
so the merchant sees exactly what shoppers get: products, winning strategy,
result count, index version, timing, zero-result state and catalog suggestions.

## 3.8 — Tests

New Phase 3 tests (all pg-verified via node-postgres — identical SQL to the
production Prisma path):

- `test/phase3-search.test.ts` (21): relevance basics + title-weight-beats-
  description; excluded content (draft/archived/unpublished never returned, not
  even via exact SKU); active-version-only + atomic swap; incremental refresh
  keeps the tsvector current; fallback cascade (AND/prefix/OR/trigram, structured
  zero-result, no-active-index → native); predictive + catalog suggestions
  (catalog-derived, title-first, no unpublished terms); query hardening
  (tsquery metacharacters / SQL-ish input can't break the query, limit clamp,
  length cap).
- `test/phase3-appproxy.test.ts` (8): App Proxy signature — valid accepted,
  forged rejected, **tampered `?shop` rejected**, extra param rejected, missing
  signature throws, shop-derived-from-signature; plus a cross-shop isolation test
  (shop A's search never returns shop B's docs; A cannot read B's docs even given
  B's version id — RLS).
- `test/phase3-index-usage.test.ts` (1, informational): on a synthetic ~10k
  catalog, EXPLAIN the FTS query (logged), assert the `psd_tsv_gin` index exists,
  is valid and is a GIN index, and the query returns the exact expected rows. **No
  latency target is asserted — those are Phase 14 and must be measured on
  representative hardware.**

Prisma-integration (`test/prisma-integration.test.ts`) is extended with a Phase 3
search assertion (build index + `searchProducts` by title and by SKU) through the
real Prisma `withShopExec`. It self-skips where the Prisma engine is unavailable.

## Environment constraint (unchanged from Phase 3.0 preflight)

This sandbox's egress proxy denies `binaries.prisma.sh`, so `prisma generate`
(the native query engine) cannot run here and must not be routed around. All
Phase 3 SQL is verified via node-postgres (identical SQL). The Prisma-backed
execution of the Phase 3 search/predictive/suggest/proxy code — and G1/G3 — RUN
on a machine with engine access; see the Phase 3 report for the exact
pg-verified-vs-live-Prisma status.
