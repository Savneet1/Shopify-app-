# Phase 13 — Localization, Markets context, B2B honesty, Combined Listings

Base: `36adafb` (Phase 12.2). No new Shopify scope (still `read_products`), no
Redis, no external service, no paid SaaS, no Shopify Function, no new npm
dependency, no new PostgreSQL extension, no new SECURITY DEFINER function.
Migrations 0017–0019 are additive and idempotent. Everything is deterministic
and rule-based.

This document is the design + honesty record. The companion
`docs/PHASE13_REPORT.md` has the test accounting, deviations and known limits.

---

## Verified-in-docs vs Requires-Verification

| Claim | Status | Basis |
|---|---|---|
| App Proxy signs ONLY `shop`, `logged_in_customer_id`, `path_prefix`, `timestamp`, `signature` — **not** locale/market/country/currency | **Verified in docs** | Shopify App Proxy reference. The storefront therefore sends locale/country/currency as **validated untrusted hints**. |
| `Product.combinedListingRole` (enum `CHILD`/`PARENT`; null = none) and `Product.combinedListing { parentProduct, combinedListingChildren }` are readable with `read_products` | **Verified in docs** | Admin GraphQL schema, pinned API `2026-07`. Confirmed via the schema tool. |
| `combinedListingUpdate` requires `write_products` | **Verified in docs** | We never call it — combined listings are read-only here. |
| Interest suggestions never reach the server | **Verified in code** | No endpoint receives interest data; a static test fails if any asset but the guarded helper touches the key. |
| Price hydration shows a true **presentment** (market) price | **Requires Verification** | `/products/<handle>.js` returns shop-currency minor units; we reformat via `Intl` in the active currency. On a real Markets store the presentment amounts must be confirmed. Default OFF. |
| Non-English UI strings are accurate | **Requires Verification** | de/es/it/pt-BR/nl/ja/ar are machine-assisted, marked `needs-native-review`. |
| Live App Proxy beacon / theme rendering / RTL on a real theme | **Requires Verification** | No DOM/live store in the sandbox; pure logic is unit-tested. |
| B2B / company catalogues / negotiated prices | **Not implemented** | Needs `read_companies` / `read_customers`; see §13.4. |

---

## 13.0 Carry-over fix — confirmation sweeper backoff (migration 0017)

Phase 12.2 added a maintenance-tick sweeper that re-enqueues stranded
double-opt-in confirmations. A shop with no working SMTP had its stranded rows
re-enqueued **every tick**, churning the queue forever.

Fix:
- The sweeper first checks `loadEmailSettingsView(shop).configured`; an
  unconfigured (or undecryptable) shop is skipped entirely — **zero** enqueues.
- Migration 0017 adds `confirm_sweep_count INT NOT NULL DEFAULT 0` and
  `confirm_last_sweep_at TIMESTAMPTZ` to `back_in_stock_subscription`.
- `selectStrandedConfirmations` now also requires
  `confirm_sweep_count < 5` **and**
  `confirm_last_sweep_at IS NULL OR confirm_last_sweep_at <= now - (1h · 2^count)`
  (exponential backoff at 1/2/4/8/16h, then the cap stops it).
- `markConfirmSwept` bumps the count and stamps the time when a batch is
  re-enqueued.
- A shop that configures SMTP later (inside the 7-day unconfirmed TTL, under the
  cap) still gets its confirmation on the next eligible tick.

Singleton keys, RLS, bounded batches and idempotence are unchanged.

**Rules/caps:** max 5 attempts; offsets 0/2/6/14/30h between sweeps (powers of
two hours). **Mutation-tested:** the attempt cap and the configured-join (see
`PHASE13_REPORT.md`).

## 13.1 Interest-based suggestions — client-only, consent-gated

The server stores and logs **nothing**. All state is ONE versioned-JSON
localStorage key `boost_interest_v1` (~4KB cap, 90-day TTL), read and written
only through three guarded helpers in `boost-core.js`
(`interestRead`/`interestWrite`/`interestClear`). Each requires
`consentAllowsAnalytics(privacyApi) === true` (fail-closed) and **deletes** the
key when consent is absent. A static test fails if any other asset references
the key.

Contents:
- **Recent searches:** ≤10, case-insensitive dedup, ≤60 chars, newest first.
  A search that looks like PII is **never stored** — the Phase 11.1
  canonicalise-then-redact pipeline is ported to `boost-core`
  (`canonicalizeForPII` + `redactPII` → `isLikelyPII`), so emails, phone/card
  digit runs and long tokens are caught even when obfuscated with full-width or
  zero-width characters.
- **Interest weights:** keyed by `type:`/`vendor:`/`tag:` of **clicked**
  products, ≤20 keys, integer counters, halved once per 30-day half-life, lowest
  evicted at the cap.

UX (predictive block): empty focus shows "Recent searches" plus "Suggested for
you" — the latter is fetched from the **existing** predictive endpoint as an
ordinary query (the top-weighted interest value or the most recent search), with
**no new server parameter**. Typing re-orders the returned set
**deterministically and stably** (`interestReorder`) — never adding or removing
an item. A per-shopper on/off control and "Clear my history" live in the
dropdown footer; an ARIA combobox/listbox with `textContent`-only rendering.
Merchant checkbox "Personalised suggestions" defaults ON but is effective only
with consent. Interest/recent data is never copied into Phase 11 analytics,
logs, URLs or any other storage.

## 13.2 Languages / i18n (migration 0019)

- **9 UI locales:** en (source), fr (reviewed), and de/es/it/pt-BR/nl/ja/ar
  (`needs-native-review`). ar is **RTL**. Key parity is green for **all** locales
  (runtime `*.json` and schema `*.schema.json`), enforced by
  `scripts/check-locale-parity.mjs` and a test.
- **Plurals:** `Intl.PluralRules` selects the CLDR category; the result count
  uses `count_one`/`count_other` templates with `{count}` filled by
  `Intl.NumberFormat` — **no string concatenation** of the noun.
- **Dates:** `Intl.DateTimeFormat` in the visitor locale + an explicit IANA time
  zone (shop tz) for pre-order/countdown dates.
- **Resolver** (`app/lib/i18n/locales.ts`, mirrored in `boost-core.js`):
  exact (case-insensitive) → base-language → `en`. Pure, hostile-input tested.
- **Direction:** the app sets `lang`/`dir` on **its own root element only**,
  never `<html>`; RTL uses CSS logical properties. A static test fails on any
  `documentElement` write.
- **Locale-scoped search config:** migration 0019 adds an OPTIONAL `locale`
  column to `search_synonym`, `search_stopword`, `search_redirect`
  (NULL = all locales). The planner applies `locale IS NULL OR locale = $x`
  where `$x` is the resolved, validated locale. With **no** locale-specific rows
  every row matches → byte-identical to pre-13.2. Redirect/stop-word unique
  indexes now include `COALESCE(locale,'')` so the same key can be scoped per
  locale; a locale-specific redirect wins over the global one. RLS unchanged.
- The locale reaches the server as an **untrusted hint** (query param), validated
  by `hints.validateLocale` (BCP-47 subset, ≤10 chars) before use; anything
  malformed → default behaviour.

## 13.3 Markets context + price hydration

- **Hints** (`app/lib/search/hints.ts`): the storefront sends
  `country` (ISO 3166-1 alpha-2), `currency` (ISO 4217) and `locale`
  (BCP-47 subset). Each is strictly validated (control-char/injection/overlong
  rejected) to a canonical value or `null`. **Server use is limited to locale
  scoping**; country/currency are validated and otherwise ignored server-side.
  Nothing is echoed back or logged, and no hint crosses a tenant boundary.
- **Client price hydration** (OPT-IN, merchant checkbox default **OFF**): for the
  ≤12 rendered result cards, fetch same-origin `/products/<handle>.js` (no
  scope), parse **defensively** (integers in minor units only), and show the
  presentment price via `Intl` in the storefront's active currency. Bounded
  concurrency 4, per-card timeout 1.5s, in-memory session cache, abort on a new
  render/navigation. It never blocks rendering and falls back **silently** to the
  indexed shop-currency price (never a mislabelled number). A `404` hides the
  card **only** when hydration is enabled. No server change; the API is
  byte-identical. Pure logic tested with an injected fetch.

**Limits:** `/products/<handle>.js` is shop-currency; true multi-currency
presentment conversion on a real Markets store is **Requires Verification**.

## 13.4 B2B — limited and honest

Without `read_companies` / `read_customers` the app cannot know a company's
catalogue or negotiated prices, so it does not pretend to:
- It does **not** use or store `logged_in_customer_id` (a static test enforces
  this across the whole `app/` tree; the token appears only in explanatory
  comments).
- The only market-relevant price mechanism is the client price hydration above —
  which reflects the storefront's own presentment price, not a B2B price — and is
  **Requires Verification**.
- No migration introduces a customer-price/company-catalogue table (static test).

**What full B2B would require:** `read_companies` + `read_customers` (and likely
protected-customer-data approval); reading company location catalogues and
price-list / catalog assignments; resolving the logged-in B2B contact to a
company location; and applying that location's price list at query time. All of
that is out of scope for a `read_products`-only app and is documented here and in
the admin `/app/localization` page rather than faked.

## 13.5 Combined listings — read-only (migration 0018)

- **Sync:** `combinedListingRole` and `combinedListing.parentProduct.id` are read
  via the bulk + single-product queries (API `2026-07`) and normalised to
  `combined_role` (`PARENT`/`CHILD`/null) + `combined_parent_gid` on `product`.
  The upsert keeps the Phase 2.1 monotonic guard
  (`shopify_updated_at >=`), so a replayed/out-of-order update never regresses
  the role.
- **Doc projection:** `docInsertSql` (the single source feeding **all four** doc
  paths — full build, incremental, single refresh, batch refresh) denormalises
  `combined_role` onto `product_search_doc` and merges combined fields into the
  card doc **only when `combined_role IS NOT NULL`**, so a shop with no combined
  listings has byte-identical docs and `content_hash`. A PARENT's
  `combinedChildCount` and aggregate `combinedPriceMin`/`Max` are **derived at
  build time** from the child rows (which carry `combined_parent_gid`), scoped to
  the same shop — never pulling another tenant's children.
- **Hide mode:** ONE per-shop `app_setting` key `combined_listing_mode`
  (`show_all` default / `hide_children` / `hide_parents`). It becomes a single
  hard `WHERE` (`combined_role IS DISTINCT FROM 'CHILD'|'PARENT'`) in the one
  planner (`buildWhere`), so results, totals and facet counts agree, plus the
  same clause in predictive, suggestions and every recommendation shelf. Products
  with NULL role are never hidden. `show_all` adds no clause → byte-identical.
- **Parent cards** show the aggregate price range additively (via
  `Core.formatPrice`), only when the payload carries it.

**Known limit:** a PARENT's derived aggregate refreshes on a full rebuild or when
the parent itself updates; a child-only price change is reconciled on the next
full sync (documented, acceptable for a read-only feature).

## 13.6 Admin `/app/localization` (registered)

Supported locales + review status; locale-scoping counts (global vs
locale-scoped synonyms/stop-words/redirects); the combined-listing mode selector
with parent/child counts; where to find the client-only toggles (price
hydration, personalised suggestions) in the theme editor; the B2B limitations
note; and a "what this app does NOT do" panel. Registered in `app/routes.ts`
(routing guard passes) and linked in the app nav.

## Data & privacy summary

- Interest/recent data: visitor's browser only, consent-gated, PII-filtered,
  never server-side.
- Hints: untrusted, validated, locale-only server use, never echoed/logged.
- No new scope, no new table of personal data, no use of the logged-in customer
  id, no server-side shopper profile.
