# Phase 10 Report — Bundles

Built on `325b75f` (Phase 9.1). Adds merchant-curated bundles: definition + admin
CRUD, visible/available gating from the active search index, an honest storefront
add-to-cart widget, a card-shaped App Proxy endpoint, and aggregate advisory
metrics. **No new Shopify scope, no Shopify Function, no new npm dependency, no
new PostgreSQL extension. `docInsertSql` unchanged.** Additive — with no bundles
configured, existing search/merch/recommendation behaviour is unchanged.

## Design decisions
- **Honesty first.** No `write_discounts` scope and no deployed Function means no
  discount can be applied, so the storefront shows only the sum of regular
  prices. The discount calculator and the admin "intended discount" are planning
  aids, labelled "not applied — needs Shopify Function; Requires Verification."
- **Hidden-or-whole.** A bundle shows only when fully satisfiable from the active
  version's visible docs + purchasable variants; otherwise it is hidden entirely
  and the admin names the blocking slot. No partial/broken bundles ever reach a
  shopper.
- **Reads, never writes, catalog state.** The engine joins the `variant` table to
  the visible `product_search_doc` rows; `docInsertSql` is not changed. The
  server never writes a cart — the browser calls the Ajax Cart API.
- **Merchant-curated beats search-hide.** Phase 8 HIDE rules do not apply to
  bundles (documented): a merchant who bundles a product means it.
- **Reused patterns.** refs/`classifyRef`, `handleProxy` + rate limit, the card
  payload shape, the Phase 9.1 signal retention path, the Core storefront helpers
  and the schema-default checkbox rule are all reused rather than reinvented.

## Tables + RLS (migration 0012)
`bundle`, `bundle_slot`, `bundle_signal_daily` — each `shop_id` FK, **RLS ENABLED
+ FORCED**, policy `shop_id = app_current_shop()`, grants to `app_runtime` only.
Additive + idempotent (applied twice with zero errors; `relrowsecurity` +
`relforcerowsecurity` + one policy verified on each). Accessed via raw
parameterised SQL under `withShop`; not modelled in Prisma.

## Tests vs 349
Full suite **395 passed | 11 skipped** (was 349 | 9 at base). Every
previously-passing test still passes; none weakened. New pg-verified suites:
- `phase10-discount` (10) — percent/fixed_amount/fixed_price, currency minor
  units, half-up rounding, per-quantity, never-negative, never-exceeds-subtotal,
  junk-input.
- `phase10-bundles` (17) — model validation (slot bounds, qty, duplicate
  rejection, mix N-of-M, schedule, intended discount, handle lower-casing) and
  the engine (shown when visible+available; hidden on unpublished / OOS /
  fixed-variant-unavailable / unknown id; mix N-of-M; schedule+status gating with
  injected clock; **index swap + rollback**; **real-shaped payload through
  `Core.toSameSitePath`/`isSafeImageUrl`/`formatPrice`** and numeric variant
  ids; CRUD round-trip; `listVisibleBundles` filtering).
- `phase10-signals` (5) — aggregate-only columns, hostile input (non-uuid,
  injection strings, oversize, bad type, other-shop bundle, nonexistent uuid →
  `ok:false`, no throw, no write), cross-tenant no-op, retention (delete old /
  keep new / other shop untouched / idempotent / batched, injected clock),
  maintenance-tick retention pass.
- `phase10-extension` (10) — `Core.cartAddUrl`/`isNumericId` pure tests + static
  checks (files wired, valid schema JSON + section target, schema-default
  checkbox form, Core helper usage, numeric-only cart variant ids + bundle line
  properties, no innerHTML, non-atomic cart handling, locale parity).
- `phase10-rls` (3) — RLS on all three tables + cross-shop isolation of
  bundle/bundle_slot + a cross-shop mutation (0 rows).
- `prisma-integration` — two added CI-only cases (bundles via the production
  Prisma path; unsigned `proxy/bundles` + `proxy/bundle-event` → HTTP 400); they
  self-skip in the egress-blocked sandbox (part of the 11 skipped).

`npm run typecheck`, `npm run build`, `npm run worker:build`, locale parity and
the Phase 8.1b/9.1 liquid-boolean sweep are green; the Phase 7 routing guard
covers the three new routes. The guards were mutation-tested: unregistering
`proxy/bundles` fails the routing guard, and flipping `show_vendor` to the wrong
checkbox form fails the static liquid + extension tests (both reverted).

## Deviations
- The admin create form exposes four slot rows inline (more can be added by
  re-saving); the model enforces 2..10 regardless. Cosmetic, not a rule change.
- `listVisibleBundles` resolves candidate bundles one-by-one (bounded ≤ 50);
  no batching/materialisation — cost is Phase 14, not claimed here.

## Known limitations
- Mix-and-match line total depends on the shopper's N picks, so the card carries
  a price RANGE (sum of the N cheapest / N dearest default line totals) and
  `total: null`; the block computes the live total from the selection.
- The storefront total is a plain decimal sum formatted client-side by
  `Intl.NumberFormat` with the shop currency; multi-currency/Markets conversion
  is Phase 13.

## Live-Prisma status
**Pending.** `binaries.prisma.sh` is egress-blocked in this sandbox, so the suite
is pg-verified via node-postgres (identical SQL) and the production Prisma path is
exercised by the self-skipping `prisma-integration` cases on hosted CI.

## Requires Verification
- Real bundle discounts — `write_discounts` scope + a deployed Shopify Function
  (reads `_bundle_id`/`_bundle_slot`, groups lines, applies the calculator's
  result at checkout) + per-bundle discount config/metafields.
- The Ajax Cart API's behaviour on a partially-failing `items[]` (atomic vs
  partial) — the widget does not assume atomicity.
- Markets/locale-prefixed cart root beyond `window.Shopify.routes.root`.
- Live theme rendering and live customer-facing cart adds; the beacon's advisory,
  inflatable counts.

## Next step
Awaiting independent verification + live-Prisma CI confirmation for the Phase 10
line. Phase 11 (Analytics) is **not** started.

## STATUS
PHASE 10 IMPLEMENTED & PG-VERIFIED (395 passed | 11 skipped). LIVE-PRISMA
CONFIRMATION PENDING. PHASE 11 NOT STARTED.
