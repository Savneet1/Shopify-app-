# Phase 9 Report — Recommendations

Built on `5312e9f` (Phase 8.1b). Adds rule-based, deterministic recommendations
computed entirely in PostgreSQL from the active search index. **No new Shopify
scope, no new npm dependency, no new PostgreSQL extension, no external service,
no ML/embeddings, no server-side per-shopper profiles.** Recommendations read
only the active index version's visible docs, so the feature is additive and
cannot change existing search/merchandising behaviour.

## What shipped

- **9.1 Content-based** `similar`/`related` (`app/lib/recommend/content.ts`,
  `refs.ts`) — one parameterised SQL over `product_search_doc` with documented
  weights (shared collections, product_type, vendor, shared tags, price-band,
  title trigram), a qualifying gate (attribute overlap OR trigram ≥ 0.3 — price
  alone never qualifies), deterministic order (`score, title, product_id`), seed
  exclusion, OOS policy, Phase 8 global-hide exclusion, cap ≤ 24, optional
  per-vendor diversification, and an `explain` breakdown.
- **9.2 Trending** (`signals.ts`, `proxy.rec-event.tsx`) — aggregate
  `product_signal_daily` fed by a hardened public beacon (validate-before-SQL,
  bounded, never-500, aggregate-only — no visitor/IP/per-user/query log);
  whole-day time-decayed score with a configurable half-life and injected clock;
  newest-visible deterministic top-up / fallback. Beacon documented as
  public/inflatable → advisory.
- **9.3 FBT** (`cooccurrence.ts`) — full deterministic co-occurrence builder over
  an abstract `BasketSource` (min-support/min-confidence/lift, symmetric pairs,
  idempotent full-replace rebuild, oversized-basket cap). **No Shopify orders are
  read; a synthetic source is used for tests only.** `fbt_enabled` defaults
  false; empty data → `[]`; optional degrade to related.
- **9.4 Recently viewed** (`boost-core.js` helpers + `boost-recommendations.js`)
  — first-party storage gated by try/catch AND the Phase 8.1 consent gate
  (fail-closed); server stores nothing; sent only as a bounded validated `recent`
  param (≤ 12 strict refs).
- **9.5 API + storefront** — `proxy/recommendations` + `proxy/rec-event`
  (registered, signed, rate-limited, never-5xx) and the `Recommendations` theme
  app block (product-template section; textContent-only; safe URL/image/price
  helpers; en+fr parity; explicit checkbox if/else).
- **9.6 Admin** — `/app/recommendations` (registered): per-type toggles, OOS
  policy, diversification cap, trending half-life, FBT data-source note, and a
  preview with per-component score breakdown. Settings persist in
  `recommendation_settings` (`settings.ts`), orchestrated by `engine.ts`.

## Tables + RLS (migration 0011)

`0011_phase9_recommendations` adds four tenant tables — `product_signal_daily`,
`product_cooccurrence`, `product_cooccurrence_build`, `recommendation_settings` —
each with `shop_id` FK, **RLS ENABLED + FORCED**, policy
`shop_id = app_current_shop()`, and grants to `app_runtime` only. Additive and
idempotent (`CREATE … IF NOT EXISTS`, `DROP POLICY IF EXISTS` before
`CREATE POLICY`); verified by applying it twice with no errors and confirming
`relrowsecurity` + `relforcerowsecurity` + one policy on each table. No new
extension (pg_trgm/unaccent predate this phase). Accessed only via raw
parameterised SQL under `withShop`, so not modelled in `schema.prisma` (same
pattern as the Phase 8 merch tables).

## Tests

Full suite: **340 passed | 9 skipped** (was 288 | 7 at `5312e9f`). Every
previously-passing test still passes; none were weakened. Six new pg-verified
suites (51 tests) plus two CI-only Prisma cases that self-skip where the engine
is unavailable:

- `phase9-content` (14) — ordering/determinism, visibility (unknown/unpublished
  seed → []), seed excluded, OOS policy, hide respected, excludeProductIds,
  cap, per-vendor diversification, `related` profile, index swap + rollback, and
  the pure `refs` validators.
- `phase9-signals` (6) — aggregate-only columns, hostile-input no-op, injected-
  clock decay ranking, newest top-up, full fallback, OOS/hide.
- `phase9-cooccurrence` (8) — support/pair/N correctness, confidence +
  minSupport/minConfidence, symmetry, lift, idempotent rebuild, empty/unknown →
  [], oversized-basket cap, visibility/OOS/hide.
- `phase9-extension` (10) — `boost-core.js` recently-viewed helpers +
  static checks (consent-gated storage, safe URL/image/price helpers,
  textContent-only, explicit checkbox if/else, beacon endpoint).
- `phase9-rls` (5) — RLS on all four tables + cross-shop isolation for signals,
  co-occurrence and settings + settings defaults/clamping.
- `phase9-engine` (8) — type switching, disabled shelves, FBT no-data→related
  fallback, FBT with data, recent listing, trending + top-up, global hide, and
  no-active-version.
- `prisma-integration` — two added cases (recommendations via the production
  Prisma path; unsigned `proxy/recommendations` + `proxy/rec-event` → HTTP 400).
  These require the generated Prisma client and run on CI; they self-skip in the
  egress-blocked sandbox (part of the 9 skipped).

`npm run typecheck`, `npm run build`, `npm run worker:build`, locale parity
(`scripts/check-locale-parity.mjs`) and the Phase 8.1b liquid-boolean static
sweep are all green; the Phase 7 routing guard confirms the three new routes are
registered.

## Live-Prisma status

**Pending.** As in every prior phase, `binaries.prisma.sh` is egress-blocked in
this sandbox, so the suite is pg-verified via node-postgres (identical SQL) and
the production Prisma path is exercised by the self-skipping
`prisma-integration` cases on hosted CI (`.github/workflows/live-prisma-check.yml`).

## Requires Verification

- **Real FBT order data** — `read_orders`, and possibly protected customer data
  / `read_all_orders`. Not approved; no orders are read. The algorithm/storage
  are ready and tested against a synthetic source; wiring a real source needs an
  explicit scope decision.
- Live App Proxy beacon + customer-privacy consent on a real store; live theme
  rendering of the recommendations block.

## Performance

Not measured. No performance numbers are claimed — benchmarks are Phase 14.

## Next step

Awaiting independent verification + live-Prisma CI confirmation for the Phase 9
line. Phase 10 (Bundles) is **not** started.

---

# Phase 9.1 — fix batch (built on `5599e84`)

Five fixes from independent verification. No new scope/dependency/extension, no
new migration, no new queue. Full suite **349 passed | 9 skipped** (was 340 | 9);
typecheck/build/worker:build clean; locale parity + routing guard + liquid-boolean
sweep green.

## K1 — trending: stale signals must not outrank fresh content

**Failing input →** with a 7-day half-life and `now = 2026-10-09`, a product
whose only signal row was `2024-01-01` scored ≈ 0.0000 yet ranked **above** a
brand-new product with no signals, because the `HAVING … > 0` admitted the
decayed-to-nothing row and the newest-first top-up never applied.
**New behaviour →** a documented signal window — only rows with
`day ≥ nowUTC − WINDOW_DAYS`, `WINDOW_DAYS = min(90, 8 × halfLifeDays)`, count
(`signals.ts`, stated in `docs/PHASE9.md`). A product with no in-window signal
drops out of the scored set and is served by the newest-visible top-up. Decay math
for in-window rows is unchanged (existing exact-value tests still pass).
Tests (`phase9-signals`): stale-only product not scored (shelf is newest order);
cutoff edge included / one day older excluded (injected clock); half-life scales
the window.

## K2 — retention for `product_signal_daily` (was unbounded)

`purgeOldSignals` (`signals.ts`) deletes rows older than `RETENTION_DAYS = 120`
(≥ the largest window) per shop under `withShop` (RLS), one bounded batch
(`PURGE_BATCH_SIZE = 10000`) per call → short locks, idempotent. Wired into the
existing maintenance-reconcile tick via `runSignalRetention` (`maintenance.ts`,
called from `worker.ts`), which enumerates installed shops by reusing
`app_shops_needing_full_sync('0 seconds')` and purges each through `withShopExec`.
No new queue. Tests (`phase9-retention`): old deleted / new kept / other shop
untouched; second run no-op; batched draining over multiple runs (injected clock);
enumerator covers all installed shops; tick path purges one batch per shop.

## K3 — case-insensitive tag overlap

**Failing input →** seed tags `["Sport","red"]` vs candidate `["sport"]` scored 0
for tags. **New behaviour →** the tag-overlap set intersection now lowercases and
de-duplicates both sides (`content.ts`); weights, caps and the collection
comparison are unchanged. Test (`phase9-content`): mixed-case overlap scores the
same as same-case and is positive; all prior content tests pass unchanged. The
latent multi-seed trigram-gate note is documented, not changed.

## K4 — Liquid checkbox defaults match schema

**Failing input →** in `boost-recommendations.liquid`, `show_vendor`
(schema default **false**) used the `== false` form, so an **unset** setting
rendered `true`. **New behaviour →** default-false checkboxes use
`{% if block.settings.x == true %}true{% else %}false{% endif %}`; default-true
keep the `== false` form, so an unset value always equals its schema default. The
static liquid test (`phase8b-liquid-booleans`) now enforces the correct form
**per schema default across all blocks** (existing default-true blocks unchanged).

## K5 — docs

`docs/PHASE9.md`: documents the signal window + retention constants, states the
beacon is aggregate/no-identifier/no-storage/no-logging and therefore
not-consent-gated — **marked Requires Verification** (legal/privacy) — while
recently-viewed **is** consent-gated, and notes the per-request visible-doc scan
cost is unmeasured (Phase 14). This report's 9.1 section records each failing
input → new behaviour.

## STATUS (9.1)

PHASE 9.1 IMPLEMENTED & PG-VERIFIED (349 passed | 9 skipped). LIVE-PRISMA
CONFIRMATION PENDING. PHASE 10 NOT STARTED.
