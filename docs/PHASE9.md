# Phase 9 — Recommendations (design & exact rules)

Rule-based, deterministic recommendations computed from the **active search
index version's visible docs** in PostgreSQL. No machine learning, no
embeddings/pgvector, no external services, no randomness, **no new Shopify
scope, no new npm dependency, no new PostgreSQL extension**. Nothing is read
outside `product_search_doc` for the generated shelves, so draft / deleted /
unpublished / other-shop products can never be recommended, and the engine
follows an index swap or rollback automatically (it reads whichever version is
active).

Types: `similar`, `related`, `trending`, `fbt` (frequently bought together),
`recent` (recently viewed). One orchestrator — `app/lib/recommend/engine.ts`
`getRecommendations()` — applies the shop's settings, the Phase 8 **global** hide
rules, and the client-supplied recently-viewed list, then dispatches to the
type's implementation. Bad input never throws: an unknown/invalid/unpublished
seed yields an empty list.

## Product references (`refs.ts`)

Every client-supplied product reference is validated and classified **before any
SQL** into exactly one of: internal `uuid`, Shopify `gid://shopify/Product/<n>`,
or storefront `handle` (`^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$`, lower-cased).
Anything else is dropped. `parseRecentRefs` validates, de-duplicates and caps a
list at **12** refs, preserving order. The storefront mirrors the same rules in
`boost-core.js` (`normalizeRef` / `parseRecentIds` / `pushRecentId`).

## 9.1 Content-based (`content.ts`) — `similar` / `related`

One parameterised SQL statement scores every visible candidate against the
resolved seed doc(s) using only indexed fields. Weighted sum with **documented,
non-learned** weights:

| Component | Source | `similar` | `related` |
|---|---|---|---|
| shared collections | `doc->'collections'` title overlap, capped | 40 × min(n,3) | 50 × min(n,3) |
| same product_type | `product_type` | 30 | 25 |
| same vendor | `vendor` | 20 | 10 |
| shared tags | `tags[]` overlap, capped | 10 × min(n,3) | 20 × min(n,4) |
| price proximity | `15 · max(0, 1 − |Δ|/max(seedPrice,1))` (relative) | 0–15 | 0–5 |
| title similarity | pg_trgm `similarity(title, seedTitle)` | 25 × sim | 5 × sim |

**Qualifying gate:** a candidate appears only if it shares a real attribute
(collection/type/vendor/tag) **or** `title similarity ≥ 0.3`. Price proximity
ALONE never qualifies an item — it only refines ordering among already-related
items. Order: `score DESC, title ASC, product_id ASC` (fully deterministic).
Seed(s) always excluded; out-of-stock excluded unless `includeOutOfStock`;
globally-hidden products excluded; result capped ≤ 24; optional per-vendor
diversification cap (`row_number() OVER (PARTITION BY vendor …)`, 0 = off).
`explain=true` returns the per-component breakdown that sums to the score (admin
"why is this here?"). Multiple seed refs sum their per-seed scores (used by
"based on what you viewed").

## 9.2 Trending (`signals.ts`)

`product_signal_daily(shop_id, product_id, day, views, clicks)` — **aggregate per
product, per UTC day**. Fed by the public App Proxy beacon `proxy/rec-event`
(`product=<ref>&type=view|click`), hardened exactly like the Phase 8 A/B beacon:
the ref and type are validated before any SQL, resolved to a **visible** product
of the shop (junk dropped), and only a bounded counter is incremented — **no
visitor id, no IP, no per-user row, no query text, no logging**; `recordSignal`
returns a boolean and never throws/500s.

Score (deterministic, injected clock):
`Σ (views·1 + clicks·3) · 0.5^(ageDays / halfLifeDays)` where `ageDays` is the
whole-day difference `now::date − day` and `halfLifeDays` is a per-shop setting
(default 7, 1..90). Clicks weigh 3×, views 1×. Trending returns signal-ranked
products; when signals cover fewer than the requested count the shelf is topped
up with **newest visible** products (`created_at_shopify DESC, title, id`); with
no signals at all the whole shelf is that newest-visible fallback.

**The beacon is public and inflatable, so trending counts are advisory** — a
heuristic shelf, never an authoritative or billable metric.

**Signal window (9.1 fix K1).** Only rows with `day ≥ nowUTC − WINDOW_DAYS` are
scored, where **`WINDOW_DAYS = min(90, 8 × halfLifeDays)`** (default half-life 7
→ 56-day window). Past ~8 half-lives a row has decayed below ~0.4% of its weight;
counting it only let a long-dead signal (score ≈ 0 but > 0) outrank genuinely
newer content and prevented the newest-first top-up from ever applying. A product
with no in-window signal now drops out of the scored set and is served by the
newest-visible top-up instead. The decay math for in-window rows is unchanged.

**Retention (9.1 fix K2).** `product_signal_daily` rows older than
**`RETENTION_DAYS = 120`** (always ≥ the largest possible window, 90) are purged
by the existing periodic maintenance/reconciliation tick: `runSignalRetention`
enumerates installed shops (reusing the `app_shops_needing_full_sync('0 seconds')`
SECURITY DEFINER enumerator) and, per shop under `withShop` (RLS), deletes one
bounded batch (`PURGE_BATCH_SIZE = 10000`) via `purgeOldSignals` — short locks,
idempotent, draining a backlog over successive ticks. No new queue was added.

**Consent posture (Requires Verification).** The view/click beacon writes only an
aggregate per-product counter with **no visitor identifier, no IP, no per-user
row, no storage of the request and no logging**, so it is treated as first-party
aggregate analytics and is **not** gated on customer-privacy consent. This
position is **Requires Verification** (legal/privacy review on a real store).
Recently-viewed (9.4) is different — it is per-shopper and **is** consent-gated.

## 9.3 Frequently bought together (`cooccurrence.ts`)

> **Scope note — data source Requires Verification.** Real FBT needs Shopify
> ORDER data (`read_orders`, possibly protected customer data /
> `read_all_orders`). That scope is **not approved** and **no Shopify orders are
> read anywhere in this build.** The full algorithm + storage are implemented
> and tested against a synthetic basket source only. `fbt_enabled` defaults
> **false**.

`product_cooccurrence(shop_id, product_a, product_b, pair_count)` stores
canonical unordered pairs with `product_a ≤ product_b`: `a=b` rows hold
single-item **support**, `a<b` rows hold the pair co-occurrence count.
`product_cooccurrence_build(shop_id, basket_count, source, built_at)` holds N for
the optional lift ranking. `rebuildCooccurrence()` consumes an abstract
`BasketSource` (baskets of refs), resolves refs to visible products, ignores
oversized baskets (cost/noise cap), and does an **idempotent full replace**.

Ranking: `confidence = pair/support(seed)` (default) or
`lift = pair·N/(support(seed)·support(cand))`; a candidate must clear both
`minSupport` (on pair_count) and `minConfidence`; order
`metric DESC, title, id`. No data / unknown seed / no qualifying pair → `[]`;
with `fbt_fallback_related` on, the API degrades to related products
(`fellBackTo:"related"`).

## 9.4 Recently viewed (only personalization — client-side)

The storefront keeps a short most-recent-first list of product refs in
first-party `localStorage` (`boost_recent`). Every read/write is wrapped in
`try/catch` **and** gated by the Phase 8.1 analytics-consent check
(`consentAllowsAnalytics`, fail-closed): with no consent nothing is stored and
no `recent` param is sent, and a stored list is cleared. **The server stores
nothing.** The list is sent only as a bounded, validated `recent` param (≤ 12
strict refs) and is used to exclude already-seen items from generated shelves and
to render the `recent` shelf itself (`cardsByProductIds`, in input order). There
are no server-side profiles.

## 9.5 API + storefront

`proxy/recommendations` (App Proxy; signature via `handleProxy`; per-shop rate
limit; never-5xx-to-storefront) — `type`, `seed`, `limit`, `recent`,
`ranking`. Payload mirrors the search result cards (title/url/image/price
range/vendor/availability) so the Phase 7.1 URL/image/price handling applies
unchanged. `proxy/rec-event` — the aggregate view/click beacon.

Theme app block `Recommendations` (target `section`, for the product template;
trending/recent also work without a seed). Settings: heading, type, count,
columns, show price/vendor, track-recently-viewed, proxy prefix/subpath,
timeout. Glue (`boost-recommendations.js`) renders with **textContent + DOM node
APIs only**, links via `Core.toSameSitePath`, images via `Core.isSafeImageUrl`,
prices via `Core.formatPrice`; on any failure/timeout/empty payload it renders
nothing (no layout shift). Every checkbox setting uses the explicit
`{% if block.settings.x == false %}false{% else %}true{% endif %}` form. Locales
en + fr are at key parity.

## 9.6 Admin

`/app/recommendations` (registered in `app/routes.ts`, routing-guard covered):
enable/disable each type, OOS policy, per-vendor diversification cap, trending
half-life, an explicit FBT **data-source = Requires Verification** note, and a
preview tool (pick a product + type → each shelf with the per-component score
breakdown). Settings persist in `recommendation_settings` (RLS); `loadSettings`
returns documented defaults until saved; `saveSettings` clamps every field.

## Tables + RLS (migration 0011)

`product_signal_daily`, `product_cooccurrence`, `product_cooccurrence_build`,
`recommendation_settings` — all tenant tables: `shop_id` FK to `shop`, **RLS
ENABLED + FORCED**, policy `USING/WITH CHECK (shop_id = app_current_shop())`,
`GRANT … TO app_runtime` only (still NOSUPERUSER/NOBYPASSRLS, no CREATE on
database). Migration is additive and idempotent (`CREATE … IF NOT EXISTS`,
`DROP POLICY IF EXISTS` before `CREATE POLICY`). No new extension (pg_trgm /
unaccent were installed in Phase 3). These feature tables are accessed only via
raw parameterised SQL under `withShop` (like the Phase 8 merch tables), so they
are intentionally not modelled in `schema.prisma`.

## Invariants (9.7)

Determinism (stable order across repeated calls); draft/deleted/unpublished/
other-shop never recommended; seed excluded; OOS policy honoured; Phase 8 global
hide honoured; follows index swap/rollback; unknown seed → `[]`; beacon
hostile-input is a no-op (never writes/throws); RLS + cross-shop isolation on
every new table; recently-viewed consent gate + storage are fail-closed; the
extension renders with textContent only. With no recommendation data/settings,
existing search/merch behaviour is byte-identical (recommendations are additive).

## Cost / performance (not measured — Phase 14)

Each content/trending request scans the active version's visible docs: content
cross-joins candidate docs against the resolved seed row(s) and computes pg_trgm
`similarity()` per candidate; trending aggregates the in-window signal rows. These
costs are **not measured** and no numbers are claimed — benchmarks and any
indexing/materialisation work are Phase 14. The content tag/collection/trigram
work is bounded by the active version's visible-doc count per request.

## Constants (9.1)

`VIEW_WEIGHT=1`, `CLICK_WEIGHT=3`, `DEFAULT_HALF_LIFE_DAYS=7`,
`WINDOW_DAYS=min(90, 8×halfLifeDays)`, `RETENTION_DAYS=120`,
`PURGE_BATCH_SIZE=10000`. Content weights/caps per the 9.1 table above. Tag
overlap is compared case-insensitively (`lower()` + distinct on both sides);
collection overlap keeps its existing title comparison.

> Latent note (not changed): `recommendContent` supports multiple seeds, but the
> orchestrator passes a single seed, so the trigram qualification threshold
> (which sums per-seed similarities) is exercised with one seed only. If a future
> change wires multi-seed, switch that gate to per-seed MAX similarity so the
> threshold does not scale with seed count. Left as-is here to avoid changing
> existing single-seed results.

## Requires Verification

Real FBT order data (`read_orders` / protected customer data / `read_all_orders`
— not approved); the **beacon's not-consent-gated posture** (legal/privacy
review); live App Proxy beacon + customer-privacy consent on a real store; live
theme rendering of the block. Performance/benchmarks are Phase 14 and are **not**
claimed here.
