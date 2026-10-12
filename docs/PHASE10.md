# Phase 10 — Bundles (design & exact rules)

Merchant-curated product bundles: definition + admin CRUD, visible/available
gating from the active search index, an honest storefront widget that adds the
bundle to the cart via the theme Ajax Cart API, a card-shaped App Proxy endpoint,
and aggregate advisory metrics. **No new Shopify scope, no Shopify Function, no
new npm dependency, no new PostgreSQL extension.** `docInsertSql` is unchanged.
Everything shown to shoppers comes from the ACTIVE index version's visible docs
(published + ACTIVE) joined to the catalog `variant` table.

## What IS implemented
- Bundle definitions (fixed set + mix-and-match), slots, schedule, status,
  intended-discount **record** (never applied), admin CRUD + preview.
- Visible/available gating; a bundle is shown only if fully satisfiable, else
  hidden entirely with per-slot blocking reasons in the admin.
- Storefront Bundle block: items, variant selectors, live **sum-of-regular-
  prices** total, "Add bundle to cart" via the Ajax Cart API with hidden
  `_bundle_id` / `_bundle_slot` line properties.
- `proxy/bundles` (card payload) + `proxy/bundle-event` (aggregate beacon).
- A pure, fully-tested discount **calculator** as reference logic for a future
  Function.

## What is NOT implemented (and why)
- **No discount is ever applied or shown to shoppers.** This app has no
  `write_discounts` scope and deploys no Shopify Function, so there is no
  mechanism to actually discount a cart. The storefront shows only the sum of
  regular prices. The calculator and the admin's "intended discount" are planning
  aids, clearly labelled **"not applied — needs Shopify Function; Requires
  Verification."**
- FBT / recommendation integration — out of scope for Phase 10.

## Data model (migration 0012)
- `bundle` — name, description, `bundle_type` (fixed|mix_and_match), status
  (draft|active|archived), `mix_pick_count` (N for mix), placement, position,
  schedule (`starts_at`/`ends_at` UTC + `timezone` for display), and the
  recorded `intended_discount_type|value|note`.
- `bundle_slot` — ordered slots: product by `gid`|`handle`, `variant_mode`
  (fixed|customer_picks), optional `variant_gid`, quantity 1..10.
- `bundle_signal_daily` — aggregate `views` + `add_to_cart_clicks` per UTC day.

All three are tenant tables: `shop_id` FK, **RLS ENABLED + FORCED**, policy
`shop_id = app_current_shop()`, grants to `app_runtime` only. Additive +
idempotent (`CREATE … IF NOT EXISTS`, `DROP POLICY IF EXISTS`). Accessed only via
raw parameterised SQL under `withShop` — not modelled in Prisma (same pattern as
Phases 8/9).

## 10.1 Definition + validation (`app/lib/bundles/model.ts`)
- 2..10 slots; quantity 1..10; name 1..200; description ≤2000.
- `fixed` → every slot is a required item; `mix_and_match` → slots are the M
  candidates and `mix_pick_count` (N) must be 1..M.
- Slot product ref validated + classified (gid|handle; handles lower-cased) via
  `refs.classifyRef`. A `fixed` slot needs a valid `gid://shopify/ProductVariant/<n>`.
- **Duplicate products across slots are REJECTED** (documented) with a clear
  message naming the slot.
- Schedule: start must precede end; both optional. Intended discount: value ≥ 0,
  percent ≤ 100.
- Slots ordered deterministically by (position, id).

## 10.2 Visibility / availability (`app/lib/bundles/engine.ts`)
A bundle is shown only when it is `active`, within `[starts_at, ends_at)` (start
inclusive, end exclusive; injected clock), **and** its required slots resolve:
- the product is a VISIBLE doc in the active version (published + ACTIVE), and
- it has ≥1 purchasable variant (catalog `variant`: `deleted_at IS NULL`,
  `available_for_sale = true`, a price, a valid numeric variant gid);
- a `fixed` slot's specific variant must itself be purchasable;
- `fixed` bundle → ALL slots must pass; `mix_and_match` → at least N candidates
  must pass (only the available candidates are surfaced).

If anything blocks it, the bundle is **hidden entirely** (never partial) and the
admin shows exactly which slot blocks it ("Product X is unpublished…", "…out of
stock", "selected variant … unavailable"). Unknown/foreign ids resolve to "not
visible" → hidden, never an error, never a cross-shop leak. The engine reads
whichever version id it is given, so it follows index swap/rollback. **Phase 8
search HIDE rules do NOT apply to bundles** — bundles are merchant-curated; a
product a merchant deliberately bundled is shown even if it is hidden from
search.

Variant price/availability come from the `variant` table joined to the visible
docs — `docInsertSql` is not touched.

## 10.3 Pricing honesty + the calculator (`app/lib/bundles/discount.ts`)
The storefront shows the **sum of regular prices** ("Total") and never a
discount or "you save". `computeBundleDiscount(lines, spec, minorDigits)` is a
pure reference implementation (integer minor units; percent / fixed_amount /
fixed_price; half-up rounding; per-quantity line totals; discount clamped to
[0, subtotal] so the total is never negative and never below zero). It is the
logic a future Shopify Function would port.

**A real bundle discount requires:** (1) the `write_discounts` scope; (2) a
deployed **Shopify Function** (product-discount or order-discount) that reads the
`_bundle_id`/`_bundle_slot` line properties, groups the lines, recomputes the
discount with this calculator's rules, and returns the discount — Shopify applies
it at checkout; (3) Function configuration/metafields to carry each bundle's
discount spec. None of this is in scope here; all are **Requires Verification**.

## 10.4 Storefront block (`blocks/boost-bundle.liquid` + `assets/boost-bundle.js`)
Product-template section. Fetches a visible bundle for the current product (or a
pinned `bundle_id`) from `proxy/bundles`, renders items (image via
`Core.isSafeImageUrl`, title link via `Core.toSameSitePath`, variant `<select>`
where the slot lets the shopper pick, quantity, price via `Core.formatPrice`), a
live total, and an "Add bundle to cart" button. For mix-and-match each candidate
has an include checkbox and the shopper must select exactly N.

Add-to-cart POSTs an `items` array to the theme Ajax Cart API at
`Core.cartAddUrl(window.Shopify.routes.root)` (root with a `/` fallback). Each
line carries `{ id: <numeric variant id>, quantity, properties: { _bundle_id,
_bundle_slot } }`. **Only validated numeric variant ids** (`Core.isNumericId`)
are ever sent. An `aria-live` region announces adding/added/error. On any non-OK
response the widget shows a clear localized error and **does not claim what was
added** — the cart API's behaviour on a partially-failing `items[]` is **not
assumed atomic (Requires Verification)**. The widget renders nothing (reserved
space collapses) when the bundle is unavailable or the fetch fails — it never
breaks the product or cart page. textContent/DOM only (never innerHTML with API
data). Locales en + fr at key parity.

Markets/locale URL prefixes beyond what `window.Shopify.routes.root` already
carries are Phase 13 — **Requires Verification**.

## 10.5 API (`proxy/bundles`, `proxy/bundle-event`)
`proxy/bundles` (signature via `handleProxy`, per-shop rate limit, never-5xx)
returns visible+available bundles for a `product` ref or a specific `bundle` id,
bounded; junk/foreign input → empty list, never an error. Payload is the card
shape (title/url/image/price range/vendor/availability) + `items`, so Phase 7.1
URL/image/price handling applies unchanged. The admin preview renders the exact
payload plus the per-slot blocking reasons.

## 10.6 Aggregate metrics (`app/lib/bundles/signals.ts`)
`bundle_signal_daily` holds per-bundle, per-UTC-day `views` + `add_to_cart_clicks`
only — **no visitor id, no IP, no per-user row, no query text, no logging**. The
public beacon `proxy/bundle-event` validates the bundle id (`isUuid`) and type
before any SQL and requires the bundle to belong to the shop, so a
junk/foreign/other-shop id is a silent no-op (`ok:false`), never a throw/500. The
admin aggregates the trailing `BUNDLE_WINDOW_DAYS` (30) and labels the numbers
**advisory** (the beacon is public and inflatable; Phase 11 analytics
supersedes). Rows older than `BUNDLE_RETENTION_DAYS` (120, ≥ window) are purged in
bounded batches (`BUNDLE_PURGE_BATCH_SIZE` 10000) by the EXISTING maintenance tick
(`runSignalRetention` purges product AND bundle signals per shop, under RLS).

## Invariants (10.7)
Determinism; draft/deleted/unpublished/OOS/other-shop products hide the whole
bundle; follows index swap/rollback; unknown ids → not shown; real-shaped payload
passes through the Core storefront helpers; beacon hostile-input is a no-op; RLS +
cross-shop isolation on every new table; extension static checks (no innerHTML,
locale parity, valid schema JSON, schema-default checkbox form, numeric-only cart
variant ids); routing-guard coverage of every new route. With no bundles
configured, all existing search/merch/recommendation behaviour is byte-identical.

## Known limitations (added in 10.1)
- **Cart UI refresh.** After a successful add the block only announces success
  via its `aria-live` status; the theme's cart drawer / cart-count bubble may not
  refresh automatically (that is theme-specific — some themes listen for a cart
  event, others require a `sections` re-render on the add call). **Requires
  Verification** per theme.
- **Draft-bundle beacon counts.** The beacon accepts view/add-to-cart counts for
  any bundle that exists in the shop, including `draft`/`archived` ones (it only
  checks shop ownership + uuid). The counts are advisory/inflatable anyway, so
  this is harmless, but a draft bundle can accumulate counts from its own shop.

## Lookup, duplicates, cost, hygiene (10.1 fix batch)
- **M1 — lookup by resolved identity.** The storefront sends the product GID when
  available and the handle otherwise; the API resolves the incoming ref (gid or
  handle, handle case-insensitive) to a visible doc's identity, then matches
  bundle slots by **gid OR lowercased handle** in SQL — so a gid-slot bundle
  shows on a handle page and vice versa. A ref that does not resolve returns `[]`
  (never "all bundles").
- **M2 — duplicate by resolved identity.** The admin save path resolves each slot
  ref (active-version docs, or the catalog `product` table when no version is
  active) and rejects two slots that resolve to the same product even when
  entered as a gid and a handle; unresolvable refs stay allowed (drafts).
  Resolve time independently blocks a bundle whose two slots resolve to one
  product, so duplicate lines never reach a shopper.
- **M3 — bounded, batched cost.** `listVisibleBundles` pre-filters matching bundle
  ids in SQL (hard-capped at `MAX_RESOLVED_BUNDLES` = 50, deterministic order)
  and then loads everything in a constant number of queries regardless of how
  many bundles exist: **a no-match product lookup costs 3 queries** (active
  version, resolve ref, candidate ids) and **a matching lookup costs 7** (+
  bundles, slots, one visible-docs query, one variants query) — down from 82 and
  242 respectively for a 40-bundle shop.
- **M4 — cart/total hygiene.** `Core.isNumericId` rejects any variant id that is
  not a positive safe integer (a 19-digit id is rejected so `Number()` can never
  round it to a different variant). Bundle totals / line totals / ranges are
  computed in integer minor units (BigInt) scaled by the largest number of
  decimal places present (minimum 2) and formatted back to a decimal string — no
  binary floating point, 3-decimal prices never truncated.

## Requires Verification
Real bundle discounts (`write_discounts` + a deployed Shopify Function); the Ajax
Cart API's behaviour on a partially-failing `items[]` (atomic vs partial);
Markets/locale-prefixed cart root beyond `window.Shopify.routes.root`; the
theme's cart drawer/count refresh after an add; live theme rendering and live
customer-facing cart adds; the beacon's advisory counts. Performance/benchmarks
are Phase 14 and are not claimed here.
