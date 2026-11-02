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

## Phase 13b — fix batch (on top of `a4afb83`)

Approved fix batch (no new features). Base `a4afb83`. New migration: **none**
(all fixes are code; the C4 reindex uses a new pg-boss queue created at runtime —
no schema migration). Scope unchanged; no new dependency/extension/definer.

| ID | Failing input (probe) | New behaviour | Query counts |
|---|---|---|---|
| **C1** (HIGH, unpublished-data leak) | Parent with children red $40 / blue $55 / oos $45 (all ACTIVE+published) + DRAFT $5 + ARCHIVED $3 + soft-deleted $2 reported `{childCount:5, priceMin:"3", priceMax:"55"}` — archived/draft prices on a published card. | The `docInsertSql` child aggregate counts/prices **only VISIBLE children** (`status='ACTIVE' AND online_store_url IS NOT NULL AND deleted_at IS NULL`). Scenario now yields `childCount 3, range 40..55`. **Rule:** childCount = all visible children (incl. OOS); price range = over available variants when any visible child is available, else over all visible children; zero visible children → `childCount 0` and **no** range keys. Identical across all 4 doc paths; other shops' children never counted. | Doc build: still one statement per doc-write path (one extra `LEFT JOIN LATERAL` with a `FILTER`). |
| **C2** (MEDIUM, stale parent) | Child price 55→99 refreshed via `refreshDocInActiveVersion` left the parent's `combinedPriceMax` at 55 until the parent itself was refreshed. | Any incremental CHILD refresh/removal (upsert, delete/unpublish, collection-member batch) re-projects the parent doc in the same unit of work. Reparent/role-change refreshes BOTH old + new parent (old parent read from a CTE pre-image in the same upsert — no extra round-trip for non-combined). Deduped per parent per batch; idempotent under replay/out-of-order (monotonic guard preserved). | Child-with-parent update: **+2** statements (active-version lookup + parent re-projection) vs a non-combined update. Non-combined update: **0** parent-refresh statements (byte-identical path). Batch of N children, one parent: parent refreshed **once**. |
| **C3** (MEDIUM, hydration scale) | `formatMoneyMinor` divided by `10^fractionDigits`; a probe rendered `1e30` as a 29-digit dollar amount; JPY would be 100× / KWD 10× off if the Ajax API normalises to hundredths. | Ajax prices are treated as **hundredths** (÷100) and formatted via `Intl` in the active currency (JPY 1290000→¥12,900; USD 12900→$129.00). Until verified, hydration is **enabled only for 2-fraction-digit currencies**; others silently keep the indexed price. Absurd (`>1e11`), non-finite, negative and non-number values → invalid. The community source is recorded as **Requires Verification** in `docs/PHASE13.md`. | No server/query change (client only). |
| **C4** (MEDIUM, legacy-doc fail-open) | Docs built before Phase 13 (NULL `combined_role` column) stayed visible under `hide_children` with no warning. | On a non-default mode save (and on `/app/localization` load) the admin computes `staleDocCount` and, if > 0, warns and **enqueues a bounded, singleton-per-shop `reindex-docs` job** (`backfillActiveSearchColumns`, idempotent) that re-projects the docs; repeated saves don't re-enqueue while one is pending (stately); "up to date" at 0. `show_all` never triggers it. | One `staleDocCount` SELECT per localization load/save; one bounded reindex per shop when stale > 0. |
| **C5** (LOW, reorder throws) | `interestReorder` threw when the scoring function threw. | The scorer is wrapped in try/catch (throw → score 0, original position); `NaN`/`Infinity`/string/`null` → 0; never throws, never adds/removes. Documented: tampered localStorage strings render with `textContent` only. | Client only. |

### Tests (13b)

New: `phase13b-parent-refresh` (11), `phase13b-stale-backfill` (6), the C1 cases
added to `phase13-combined` (now 25), the C3 cases rewritten in
`phase13-hydration` (21), the C5 cases added to `phase13-interest` (18), and a
`reindex-docs` case added to `jobs-pgboss.integration` (5).

**Tests I had to change (none weakened):** `phase13-hydration` — the two
pre-13b `formatMoneyMinor` currency-exponent assertions were replaced to reflect
the corrected ÷100 money scale (the USD result is unchanged; the JPY expectation
changed from ¥2,000 to ¥12,900 for input 1290000, because 1290000 hundredths =
¥12,900). No other existing test changed.

### Mutation testing (13b)

Three new guards were mutation-tested (mutation applied → a test fails →
reverted): **(C1)** dropping the `status='ACTIVE' AND online_store_url IS NOT
NULL` child-visibility predicate re-admits draft/archived children →
`phase13-combined` fails; **(C3)** making `currencyHydrationEligible` always true
→ `phase13-hydration` JPY-fallback test fails; **(C5)** removing the try/catch in
`interestReorder` → `phase13-interest` "throwing scorer" test throws. (The
earlier Phase-13 mutation tests for the combined hide clause and the sweeper cap
still hold.)

### Gates (13b)

`typecheck`, `build`, `worker:build`, `npm test`, `npm run test:ci-parity` — see
the STATUS line for both counts. Live-Prisma parity: **PENDING**. No performance
numbers claimed.

## Next step

Await explicit approval for **Phase 14** (performance + security hardening +
large-catalog benchmarks). No performance numbers are claimed here.
