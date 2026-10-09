# Phase 8 — Merchandising + A/B testing (design & exact rules)

Rule-based, deterministic. No ML, no randomness in ranking, no personalization.
All merchandising is applied INSIDE the one query planner (never a post-filter),
so results, totals and facet counts cannot drift. No new Shopify scope, npm
dependency, or PostgreSQL extension. Migration `0010_phase8_merchandising`.

## Where it plugs into the planner

The single shared predicate `buildWhere` (app/lib/search/match.ts) and the single
`runProducts` ORDER BY (app/lib/search/query.ts) are the only integration points;
`PlannedMatch.merch` carries the plan to products, totals and facets alike.

- **hide** → a hard `WHERE product_id <> ALL($ids)` appended in `buildWhere`,
  exactly like the publication/draft exclusion. It therefore removes the product
  from search results, totals, every facet count, predictive and suggestions —
  but never from product pages. Added only when there is something to hide, so a
  no-rules request is byte-identical to Phase 6.1b.
- **pin** → a global ORDER BY key: `array_position(pinnedIds, product_id) ASC
  NULLS LAST` placed first, so pinned products occupy fixed top positions that
  are **stable across pagination** (it is part of the global ordering, not a
  per-page reshuffle). A pin only affects a product that already matches the
  query/filters and is visible — non-matching/hidden/draft pins are simply
  absent from the base set, so they have **no effect** (we never inject a
  product).
- **boost/demote** → a bounded delta added to the score, ordered AFTER the match
  class: `… cls_rank DESC, (score + merch_delta) DESC …`. Because `cls_rank`
  (the class weight) is the dominant key, a boost can only reorder WITHIN a match
  class and **can never outrank a higher class — in particular never an
  exact-SKU hit**.

Pins and boost/demote apply to the **relevance** sort only (price/newest are
explicit user choices); **hide applies to every sort**. These merch ORDER BY
terms are added only when rules are active, so price/newest and the no-rules path
are unchanged.

## Numbers

- Class weights (ranking.ts): sku 600 > exact 500 > prefix 400 > synonym 300 >
  fuzzy 200 > partial 100 — steps of 100.
- boost/demote `weight` ∈ **1..90** (default 50), stored and clamped. 90 < the
  100 class gap, so even ignoring the `cls_rank` key a boost could not cross a
  class; with the `cls_rank` key it is guaranteed.
- A/B `weight_override` ∈ **−90..90**, added to that variant's boost/demote
  deltas and re-clamped to ±90.
- Caps: 500 rules/shop, 200 targets/rule, 200 banners/shop, 50 experiments/shop,
  banner title ≤120 / body ≤500 chars, ≤3 active banners returned.

## Conflict resolution (documented, deterministic)

Per product, across all active rules: action precedence **hide > pin > boost >
demote**; among rules of the winning action, the **lowest `priority`** wins,
ties broken by **rule id**. Each product ends with at most one effective action.
Pin order among pinned products: `position` ASC, then priority, then rule id.

## Scheduling (8.2)

Each rule has optional `starts_at`/`ends_at` (stored UTC `timestamptz`; the
shop's IANA `timezone` is captured for display only). The active window is
evaluated **in SQL** against a **single `now`** passed per request (so every part
of the request agrees): `(starts_at IS NULL OR starts_at <= now) AND (ends_at IS
NULL OR now < ends_at)` — **start inclusive, end exclusive**. Expired/future
rules have no effect.

## Scope (8.1)

A rule/banner applies when its scope matches the request: `global` (always),
`query_exact` (normalizeQuery(q) == normalizeQuery(scope)), `query_contains`
(normalized substring), `collection` (exact collection gid). Scope is matched
against the **raw shopper query** (what they typed), not the NL-remaining text.

## Banners (8.3)

Per-query / per-collection, scheduled. `image_url` must be https on
`cdn.shopify.com` / the shop's domain (or a same-site path); `link_path` must be
a same-site path; title/body bounded. Validated server-side on save AND again
when emitted, and re-validated in the storefront via the Phase 7.1 allowlist
(`isSafeImageUrl` / `toSameSitePath`) before rendering — text is written with
`textContent` only. The search payload returns `banners: [{title, body, imageUrl,
linkPath}]`.

## A/B testing (8.5)

An experiment has a name, status (draft/running/stopped), a split-to-B percent,
and an optional bounded weight override per variant. A **variant is a rule set**:
merch rules tagged `variant` 'A'/'B' apply only when their experiment is running
and the visitor is in that variant; untagged rules are always-on. **Assignment**
is deterministic: `fnv1a32(shopId:experimentId:token) % 100 < splitPct → B else
A`; **no token → control** (the default rule set). The storefront generates a
random anonymous token in first-party storage, **gated on analytics consent**
(Phase 8.1): the token is only created or read when the merchant A/B toggle is on
AND `Core.consentAllowsAnalytics(window.Shopify.customerPrivacy)` returns strictly
true (fail-closed — absent API / missing method / non-true / throw → control);
the token is created lazily (only after a running experiment is seen, so the
first view is control) and deleted when consent is absent or withdrawn
(`visitorConsentCollected`). No PII, no IP, no fingerprinting. The **exact
customer-privacy API method names/behaviour are Requires Verification** on a real
store; failing closed means a wrong guess only ever yields control, never
tracking. The token is bounded to 1..64 chars of `[A-Za-z0-9_-]` at the client
and re-validated server-side (`sanitizeToken`). Only **aggregate** exposure/click
counts per variant are
recorded (`ab_exposure`); no per-user rows, no logged queries. **Stopping an
experiment restores the default rule set immediately** (variant rules become
inert the moment status != 'running'). Conversion/revenue and significance are
**not** computed (Phase 11 analytics); the report shows exposures, clicks and CTR
with an explicit "not statistically tested" note.

## Tables + RLS (migration 0010)

Five tenant tables, each `shop_id` FK, **RLS ENABLED + FORCED**, policy
`<t>_tenant_isolation USING/WITH CHECK (shop_id = app_current_shop())`, grants
`SELECT/INSERT/UPDATE/DELETE` to `app_runtime` only (NOSUPERUSER/NOBYPASSRLS).
`DROP POLICY IF EXISTS` before `CREATE POLICY`; additive/idempotent.
- `ab_experiment` (name, status, split_pct, weight_override_a/b)
- `merch_rule` (action, scope_type, scope_value, priority, position, weight,
  starts_at, ends_at, timezone, enabled, experiment_id→ab_experiment ON DELETE
  SET NULL, variant)
- `merch_rule_target` (rule_id→merch_rule ON DELETE CASCADE, target_kind, target_value)
- `merch_banner` (scope_type, scope_value, title, body, image_url, link_path,
  priority, starts_at, ends_at, enabled)
- `ab_exposure` (experiment_id→ab_experiment ON DELETE CASCADE, variant,
  exposures, clicks; unique per shop+experiment+variant)

No change to `docInsertSql` or the indexed fields; merchandising reads the active
version's docs and never alters the index.

## Invariants (8.6)

results == facets under every rule type (hide especially, since it's one shared
predicate); RLS + cross-shop isolation on all new tables; hostile inputs rejected
(bounded lists/targets, bad IDs resolve to nothing, script/HTML banner text
rendered as text, javascript:/data:/protocol-relative links rejected by the
allowlist, invalid schedules rejected); determinism (same input + same `now` →
same output); never worse than Phase 6.1b (empty plan → unchanged output).

## Pin order (not absolute slots)

`position` is a **pin order** (1 = first among pinned products); pinned products
always appear at the top of the relevance results, ordered by `position` then
priority then rule id. Pinning a product to an **absolute Nth slot** (e.g. always
3rd overall) is **NOT implemented** — true slot positioning is not cheap or exact
under pagination + filters (it needs absolute offset insertion with gap handling
when fewer products match), so Phase 8 keeps the honest, stable relative order. A
lone pin with order 5 therefore appears first, not in slot 5.

## Known limitations (Phase 8.1)

- **The A/B beacon endpoint is public.** The App Proxy signature only proves a
  request came through the shop's proxy, not that a real exposure/click happened.
  A malicious visitor can inflate `ab_exposure` counters, and they cannot be
  de-duplicated without per-user data (which we deliberately do not store).
  Per-shop rate limiting applies (shared storefront limiter). **Treat experiment
  numbers as advisory** until Phase 11 analytics.
- **Banner title/body are stored and returned as raw text** (not HTML-escaped).
  Every renderer MUST use `textContent` / React text nodes — the storefront block
  does. Do not inject banner text as HTML anywhere.
- **`loadMerchPlan` adds a few queries per search/predictive request** (running
  experiments, active rules + targets, target resolution). Not measured —
  performance is Phase 14.

## Requires Verification

- The exact Shopify customer-privacy API method names/behaviour behind
  `consentAllowsAnalytics` (fail-closed → control on any uncertainty).
- Live storefront beacon delivery (sendBeacon) and the admin deep-link flows.
- Conversion / revenue attribution and statistical significance (Phase 11).
- Merchant checkbox toggles (`nl_enabled`, `show_banners`, `ab_testing`) are
  rendered with an explicit `{% if … == false %}` so an unchecked box disables
  the feature (Phase 8.1b — the `| default: true` filter had overridden a false
  value). The actual on/off behaviour on a real theme is **Requires
  Verification**.
