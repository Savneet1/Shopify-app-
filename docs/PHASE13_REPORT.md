# Phase 13 — Report

Base: `36adafb` (Phase 12.2). Scope unchanged (`read_products`). Migrations
0017–0019 (additive, idempotent). No Redis, external service, paid SaaS, Shopify
Function, new npm dependency, new PostgreSQL extension, or new SECURITY DEFINER
function. Design detail: `docs/PHASE13.md`.

## Design decisions

- **Sweeper (13.0)** gated on the shop's decryption-aware `configured` flag
  rather than an SQL join on raw settings, so an unconfigured shop burns no
  attempt-cap budget and late configuration releases rows within the 7-day TTL.
  Backoff state is two columns on the existing subscription table (migration
  0017); singleton keys and RLS are untouched.
- **Interest (13.1)** is deliberately server-blind. One versioned localStorage
  key, one guarded accessor, consent fail-closed, PII filtered with the ported
  Phase 11.1 pipeline. "Suggested for you" reuses the existing predictive
  endpoint as an ordinary query, so no new server parameter and no new data path.
- **i18n (13.2)** keeps a fixed key set across all 9 locales (parity-enforced)
  and uses `Intl.PluralRules`/`Intl.NumberFormat`/`Intl.DateTimeFormat` so no
  grammar is hard-coded. Locale scoping is one optional column + a
  `locale IS NULL OR locale = $x` predicate; with no locale rows it is
  byte-identical, which is the safety property the tests pin.
- **Markets (13.3)** respects the App-Proxy signing boundary: locale/country/
  currency are untrusted hints, validated before any use, and only locale feeds
  SQL (scoping). Price hydration is a client-only, opt-in display reformat.
- **B2B (13.4)** is honestly unimplemented; the logged-in customer id is never
  touched, enforced by a static test.
- **Combined listings (13.5)** store only role + parent gid and derive the parent
  aggregate from child rows at doc-build time, so the hide mode is one hard WHERE
  in the single planner (plus the standalone doc queries), identical across
  results/facets/totals/predictive/suggest/recommendations.

## Migrations, tables & RLS

| Migration | Change | RLS |
|---|---|---|
| 0017 | `back_in_stock_subscription += confirm_sweep_count, confirm_last_sweep_at` | unchanged (existing per-shop policy) |
| 0018 | `product += combined_role, combined_parent_gid` (+ partial indexes); `product_search_doc += combined_role` | unchanged |
| 0019 | `search_synonym/search_stopword/search_redirect += locale` (+ partial indexes); redirect & stop-word unique indexes now include `COALESCE(locale,'')` | unchanged — existing per-shop `FOR ALL` policies already cover the new column |

No new tenant table was introduced; `combined_listing_mode` reuses the existing
RLS-enabled+forced `app_setting` key/value table. No new grants, no new
SECURITY DEFINER function, no RLS weakening.

## Tests vs the 647 baseline

- Baseline carried into this phase: **647 passed | 13 skipped**.
- `npm test` (full suite) now: **730 passed | 13 skipped** across 69 files — the
  647 baseline is entirely preserved (no test weakened or removed) plus **83 new
  Phase 13 tests**.
- `npm run test:ci-parity` (suite re-run in a scrubbed environment derived from
  the CI workflow's `env:` block, no `.env`): **see STATUS line** — same pass
  count, confirming no test depends on a developer's `.env`.

New test files: `phase13-combined`, `phase13-interest`, `phase13-hints`,
`phase13-hydration`, `phase13-b2b`, `phase13-i18n`, `phase13-i18n-client`
(plus the three new 13.0 cases added to `phase12-sweeper`).

Coverage highlights: combined hide identical across the 4 doc paths and the 6
surfaces; byte-identical-when-off for combined mode, locale scoping and price
hydration; hostile hint/ locale validation; interest consent fail-closed +
PII-never-stored + static "key touched only in the guarded helper"; locale key
parity for ALL 9 locales; RLS/cross-shop isolation for combined aggregates and
locale-scoped rows; routing-guard coverage for `/app/localization`; `dir` set on
the app root only (static).

## Mutation testing (≥2 required)

Three guards were mutation-tested — each mutation was applied, the suite was run
to confirm a test **fails**, then the mutation was reverted:

1. **Combined hide WHERE clause** — `combinedHidePredicate("child")` forced to
   return `null`: `phase13-combined` hide tests fail (children reappear in
   results/totals/facets).
2. **Sweeper attempt cap** — `confirm_sweep_count < MAX_CONFIRM_SWEEP_ATTEMPTS`
   dropped from `selectStrandedConfirmations`: the `phase12-sweeper` backoff-cap
   test fails (a 6th enqueue occurs past the cap).
3. **Interest consent guard** — `consentAllowsAnalytics` forced to `true`:
   `phase13-interest` "NO consent deletes the key / writes nothing" tests fail.

(See the STATUS line for the confirmation that these were run.)

## Query counts (new hot paths; no timings — Phase 14 owns benchmarks)

- Storefront search adds, per request: 1 `loadCombinedMode` read and the
  locale-scoped stop-word + synonym reads already part of `buildPlan` (now
  carrying a `locale` predicate, same number of statements). The combined hide
  and locale predicates are extra `WHERE` fragments on the **existing** product,
  facet, predictive and suggest queries — **no new round-trips** on those paths.
- Predictive adds 1 `loadCombinedMode` read.
- Recommendations add 1 `loadCombinedMode` read per request; the hide clause is a
  fragment on the existing candidate queries.
- Doc build adds one `LEFT JOIN LATERAL` (child aggregate) to the single
  `docInsertSql`; still one statement per doc-write path.

## Deviations

- Non-English UI strings (de/es/it/pt-BR/nl/ja/ar) are machine-assisted and
  marked `needs-native-review` in `app/lib/i18n/locales.ts` and the admin page;
  the merchant-facing **schema** locale files reuse the English labels pending
  translation (keys are present for parity).
- Merchant schema strings were not translated (admin is English-first); only the
  shopper-facing runtime strings were localised.

## Known limitations / Requires Verification

- Price hydration shows a reformatted shop-currency amount; true presentment
  conversion on a real Markets store is **Requires Verification** (default OFF).
- Live App Proxy beacon, theme rendering, RTL on a real theme, and consent API
  method names are **Requires Verification** (no DOM/live store in the sandbox).
- A PARENT's aggregate price reconciles on full sync / parent update, not on a
  child-only price change between syncs.
- Non-English translations need native review.
- B2B company pricing is **not implemented** (needs `read_companies` /
  `read_customers`).
- Live-Prisma parity (the generated client path): **PENDING** until the GitHub
  Actions workflow is run.

## Gates

`npm run typecheck`, `npm run build`, `npm run worker:build`, `npm test`, and
`npm run test:ci-parity` — results on the STATUS line.

## Next step

Await explicit approval for **Phase 14** (performance + security hardening +
large-catalog benchmarks). No performance numbers are claimed here.
