# Phase 6 — Semantic Layer / Natural-Language Query Parser

A rule-based, deterministic NL parser that turns a shopper's phrase ("cheap red
Nike shoes under $50 in stock") into the EXISTING Phase 4 filters + Phase 5 query
plan + a sort hint, with a transparent "interpreted as" trace. API + admin only
(no theme/storefront UI — Phase 7). Global rules held: **no Redis, no external
search/AI/ML, no embeddings/pgvector, no paid SaaS, no new Shopify scope, no new
npm dependency, no new PostgreSQL extension.**

## Design decisions

- **Parse → merge into the existing pipeline; do not fork search.** The parser
  (`app/lib/search/nlparse.ts`) extracts intent and returns `RawFilters` + a sort
  hint + the remaining free text. Those filters go through the SAME
  `normalizeFilters()` validation as manual params, and the remaining text feeds
  the SAME Phase 5 planner (`rewrite.ts → match.ts`). So products AND facet counts
  use one code path — they cannot drift, and the own-selection-excluded facet
  logic is untouched.
- **Deterministic, no ML.** Pure regex/dictionary rules; `parseQuery` is a pure
  function given a per-shop context, so the same input always yields the same
  output (tested).
- **Brand/type matched against live, VISIBLE facet values.** Vendor and
  product_type candidates are read from `product_search_doc` (published + ACTIVE)
  of the active version, so a draft-only vendor/type never influences parsing and
  the match is per-shop (RLS).
- **Attributes via a per-shop dictionary** (`search_attribute_term`) with English
  defaults in code (colors/sizes/gender → tags, materials → the material
  metafield). Admin-managed; row overrides a default by phrase.
- **Never worse than Phase 5.** If parsing produces zero results while plain
  search would not, the orchestrator falls back to plain Phase 5 search and flags
  `fellBack: true`. NL can also be disabled per request (`nl=0`) or have
  individual interpretations dropped (`ignore=price,vendor`).

## Exact parsing rules

Run on the lower-cased query (bounded to 200 chars), in this order, each matched
phrase removed before the next step:

1. **Price** (only with an explicit cue — a bare number is never a price):
   - `between X and Y` / `between X to Y` → min/max (sorted).
   - `under|below|less than|cheaper than|up to|at most X` → priceMax.
   - `over|above|more than|at least|starting at|from X` → priceMin.
   - `around|about|approximately|~ X` → ±20% band (`X*0.8`..`X*1.2`).
   - `X` accepts an optional leading currency symbol (`$ £ € ₹`) and optional
     trailing currency word (dollars/usd/rs/inr/rupees/pounds/gbp/euros/eur),
     0..1e9, up to 2 decimals.
2. **Availability**: `out of stock|sold out|unavailable` → available=false (checked
   first); `in stock|in-stock|available` → available=true.
3. **Sort** (only hints the data supports — no popularity/best-selling invented):
   `cheapest|lowest price|least expensive|cheap` → price_asc;
   `most expensive|highest price|priciest|dearest` → price_desc;
   `newest|latest|new arrivals|most recent` → newest.
4. **Brand / product type / attribute** (token scan, longest phrase first, each
   token consumed once): a contiguous token run equal to a known vendor →
   `vendor` filter; equal to a known product_type → `productType`; equal to a
   dictionary phrase → its facet (tags/metafield/product_type/vendor). Multi-word
   phrases ("the north face", "rose gold") are matched.
5. **Remaining** unconsumed tokens become the free-text query for the Phase 5
   planner.

**Negation**: a recognized brand/type/attribute immediately preceded by
`not|no|without|except|excluding|sans` is DROPPED — not applied as a positive
filter and not left as free text. Negative FILTERING (actually excluding "red")
is intentionally **unsupported** (documented) and degrades safely: the parser
never searches for the thing the shopper said to exclude.

## Conversion & transparency

`storefrontSearchWithExec` (NL on by default; `nl:false` disables):
parse → `mergeRawFilters(explicit, parsed)` (explicit scalar params win; array
groups union) → `normalizeFilters` → run the one core (plan → ranked products →
facets, with the parsed `sort`). The response adds:
- `sort` — the effective sort.
- `interpretedAs` — `{ enabled, applied, interpreted:[{kind,text,detail}],
  remaining, negations, sort, fellBack }`.

The admin Search playground shows the `interpretedAs` block and a "Natural-language
parsing" toggle. The App Proxy `products` route accepts `nl`, `ignore`, `sort`.

## Sort hints & the "newest" data

`sort ∈ relevance|price_asc|price_desc|newest`. `relevance` (default) is the
Phase 5 rule-based score. The others are deterministic column orders with a stable
`product_id` tie-break and `NULLS LAST`. For `newest`, Shopify `product.createdAt`
(read_products — no new scope) is captured through the sync path into
`product.product_created_at` and mirrored to `product_search_doc.created_at_shopify`
**inside the shared `docInsertSql`** (so it is rebuilt in every doc-writing path,
per version, from the same source — the invariant holds). An indexed btree
`(shop_id, index_version_id, created_at_shopify)` backs the sort.

## New table + columns (migration 0009, additive, idempotent)

- `search_attribute_term` (tenant table): `shop_id` FK, `phrase`, `facet`
  (`tags|metafield|product_type|vendor`), `value`; unique `(shop_id, phrase)`.
  RLS **ENABLED + FORCED**, policy `…_tenant_isolation USING/WITH CHECK (shop_id =
  app_current_shop())`, `SELECT/INSERT/UPDATE/DELETE` to `app_runtime` only.
- `product.product_created_at TIMESTAMPTZ` + `product_search_doc.created_at_shopify
  TIMESTAMPTZ` + btree index. No new extension; `DROP POLICY IF EXISTS` before
  `CREATE POLICY` so re-application is safe.

## Invariants preserved

- One query planner drives search AND facets; parsed intent becomes the SAME
  filters + plan, so results/facets can't drift (tested: facet counts consistent
  under parsed filters).
- `docInsertSql` stays the single source; `created_at_shopify` is derived there,
  per version, from visible docs.
- Publication/draft exclusion stays a hard WHERE everywhere; brand/type candidates
  read only visible docs.
- All user strings parameterised; the parser only ever emits values that pass
  `normalizeFilters` (capped arrays/length) — tested with SQL metacharacters,
  huge strings, unicode.
- RLS on `search_attribute_term`; one shop's dictionary/vendor never affects
  another (tested).

## Safety / limits

Input bounded to 200 chars; array filter groups capped by `normalizeFilters`
(≤50 values, ≤100 chars each); attribute dictionary ≤2000 rows/shop. Parser is
pure/deterministic. Hostile input (SQL metacharacters, oversized, unicode
combining) is tokenised and treated as free text — never concatenated into SQL.

## Known limitations / REQUIRES VERIFICATION

- **Negative filtering is unsupported** (negation only suppresses the positive
  interpretation). A true "exclude red" filter is a later phase.
- Attribute dictionary **values must match the stored facet value** (e.g. a tag's
  exact text); mapping is case-sensitive on the value side as applied through the
  facet filter. Defaults assume lower-case tag values.
- English-first defaults; non-English queries are a safe no-op (whole query stays
  free text).
- `newest` depends on `product.createdAt` being present; products synced before
  this phase have it only after a re-sync/rebuild (then it is populated like any
  other indexed field). Nulls sort last.
- **No performance numbers** (Phase 14). The parser adds a per-request context
  fetch (distinct vendors/types + dictionary) and, on a parsed zero-result, one
  extra plain search for the fallback.
- Live-Prisma execution of the Phase 6 path runs on GitHub Actions; it self-skips
  in the egress-blocked sandbox (as in prior phases).
