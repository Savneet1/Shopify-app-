# Phase 8 Report — Merchandising + A/B testing

Built on Phase 7.1b (commit `fb0c561`), continuing the existing git history
(fast-forward). Rule-based/deterministic — no ML, no randomness in ranking, no
personalization. No new Shopify scope, npm dependency, or PostgreSQL extension.
Migration `0010_phase8_merchandising` (additive/idempotent). Full design & exact
rules: `docs/PHASE8.md`.

> STATUS: implemented + pg-verified in the sandbox. Live-Prisma confirmation
> PENDING (`.github/workflows/live-prisma-check.yml`, unchanged, applies 0010).
> Phase 9 not started.

## Design decisions

- **Everything inside the one planner.** hide = a hard `WHERE` in the shared
  `buildWhere` (so it drops from results, totals, every facet, predictive and
  suggestions identically); pin = a global ORDER BY key (stable across
  pagination); boost/demote = a bounded score delta ordered AFTER the match
  class. `PlannedMatch.merch` threads one plan to products, totals and facets —
  they cannot drift.
- **Visibility is never overridden.** A pin/boost/hide of a draft, unpublished,
  deleted or other-shop product has no effect: the planner's hard visibility
  `WHERE` removes it from the base set before ordering.
- **Relevance-only for pin/boost/demote; hide everywhere.** Price/newest are the
  shopper's explicit choice; the merch ORDER BY terms are added only for
  relevance and only when rules are active, so price/newest and the no-rules
  path are byte-identical to Phase 6.1b.
- **Deterministic A/B.** `fnv1a32(shop:experiment:token) % 100` vs the split;
  no token → control. Only aggregate counts; no PII, no per-user rows, no logged
  queries, no significance math.

## Exact rules & numbers

Conflict precedence **hide > pin > boost > demote**, then lowest `priority`, then
rule id. boost/demote weight 1..90 (default 50) applied after the class (class
steps are 100 apart → a boost can never cross a class, in particular never
outranks an exact-SKU hit). A/B weight override ±90. Schedule window in SQL
against one `now`, **start inclusive / end exclusive**. Scope: global /
query_exact / query_contains / collection, matched against the raw query. Caps:
500 rules, 200 targets/rule, 200 banners, 50 experiments. See `docs/PHASE8.md`.

## Tables + RLS

Five tenant tables (migration 0010): `ab_experiment`, `merch_rule`,
`merch_rule_target`, `merch_banner`, `ab_exposure` — each `shop_id` FK, RLS
ENABLED + FORCED, `USING/WITH CHECK (shop_id = app_current_shop())`, grants to
`app_runtime` only. `DROP POLICY IF EXISTS` before `CREATE POLICY`. No change to
`docInsertSql` / indexed fields.

## Admin + storefront

Admin pages (embedded, no Polaris — matching the existing app): `/app/merch`
(rules CRUD + enable/disable + preview pointer), `/app/banners` (banners CRUD),
`/app/experiments` (experiments CRUD + status + exposures/clicks/CTR with a "not
statistically tested" note). The search playground now shows a per-product
"pinned #N / boosted +N / demoted −N" explanation with the rule id. All new
routes are registered in `app/routes.ts` and covered by the Phase 7 routing
guard. The theme app-extension results block renders banners (textContent +
allowlisted image/link) behind a merchant toggle, generates an anonymous A/B
token in first-party storage, sends the `abt` token to the proxy, and beacons
aggregate exposure/click to `/proxy/merch-event`. Locale parity (en+fr) and the
extension static checks still pass.

## Tests vs 254

Full sandbox suite: **Test Files 29 passed (29), Tests 275 passed | 7 skipped
(282)** — up from 254 passed | 7 skipped. **+21**:
- `phase8-units` (11): A/B determinism, split accuracy (~30% over 20k tokens,
  ±3pp), independent per-experiment bucketing, scope matching (all four kinds),
  banner validators (same-site path, allowlisted image).
- `phase8-merch` (10, engine via node-postgres): no-rules baseline unchanged +
  empty merch fields; pin fixed-top + stable across pagination + ignored under
  price sort; hide excludes from products/total/facets/predictive/suggestions;
  pin of draft/unknown has no effect; boost reorders within a class AND never
  outranks an exact-SKU hit; schedule window with an injected clock (start
  inclusive, end exclusive); banner scoped + sanitized payload; A/B variant
  isolation (B vs A vs control) + stop restores default; aggregate exposure/click
  counters (draft/ bad-variant no-op); cross-shop isolation + RLS.

All 254 prior tests pass unchanged — none weakened. `typecheck` 0 errors;
`build` OK; `worker:build` OK. The 7 skips are the CI-only `prisma-integration`
cases. No performance numbers (Phase 14).

## Deviations

- Pin "fixed position" is implemented as a stable global ordering by configured
  `position` (pins fill the top slots in position order), not an absolute slot
  index — this is what keeps it stable across pagination and avoids gaps when
  fewer products match. Documented.
- A/B exposure is recorded by a storefront beacon (one per experiment per load)
  rather than server-side auto-counting, to avoid inflating counts across
  pagination/filter requests.

## Requires Verification

- Shopify customer-privacy / consent gating of the anonymous token (default is
  control when unknown) — storefront behavior on a real store.
- Live beacon delivery (`sendBeacon`) and the admin theme-editor flows.
- Conversion / revenue attribution and statistical significance (Phase 11).
- Live Prisma execution of migration 0010 + the Phase 8 path (runs on CI;
  self-skips in the egress-blocked sandbox).

## Next step

Push these changes (fast-forward on `fb0c561`) and run
`.github/workflows/live-prisma-check.yml` — it applies migration 0010 via
`scripts/db-apply.sh` and runs the full non-skipped suite through the real Prisma
engine. Send the run URL; the live results will confirm the sandbox
verification.

STATUS: PHASE 8 IMPLEMENTED & PG-VERIFIED (275 passed | 7 skipped). LIVE-PRISMA
CONFIRMATION PENDING. PHASE 9 NOT STARTED. AWAITING LIVE-PRISMA RUN AND EXPLICIT
USER APPROVAL.
