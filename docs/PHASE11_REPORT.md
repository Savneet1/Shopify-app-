# Phase 11 Report — Analytics

Built on `f3f24f9` (Phase 10.1). Adds first-party, privacy-first search analytics
computed entirely in PostgreSQL. **No new Shopify scope, no Web Pixel extension,
no external analytics service, no new npm dependency, no new PostgreSQL
extension. `docInsertSql` unchanged. No IP / user-agent / fingerprint / customer
identifier is ever stored.** Analytics is **OFF by default**; with it off,
existing behaviour is byte-identical to Phase 10.1.

## Design decisions
- **Partitioned by month, RLS on parent AND every partition.** `analytics_event`
  is RANGE-partitioned on `occurred_at`. `app_runtime` gets DML on the **parent
  only** (no grant on any partition), so a partition is unreadable/unwritable
  directly — all access routes through the parent policy. Partition DDL is done
  by owner-owned `SECURITY DEFINER` functions the runtime may only `EXECUTE`. No
  DEFAULT partition, so nothing silently accumulates.
- **Server-stamped time.** `occurred_at` is always the server clock; a client
  `ts` is accepted in the payload only so the unknown-keys check passes, then
  ignored.
- **Opt-in + fail-closed privacy.** Default `off`. `consented_sessions` keeps a
  session id only behind the Phase 8.1 consent gate. PII is redacted from the raw
  query *before* normalization (emails, URLs, card/phone digit runs, long
  tokens) → `[redacted]` + flag; the original is never stored.
- **Everything that grows has a window + retention from day one.** Per-shop row
  purge (bounded batches) + global partition drop on the existing maintenance
  tick; every report always applies a window clamped to retention.
- **Honesty.** The beacon is public/inflatable → advisory. The A/B readout gates
  on minimum samples and never claims causal lift or revenue. Purchase
  attribution + Web Pixel are built only as pure, unwired modules and marked
  Requires Verification.
- Reused patterns throughout: `handleProxy` + rate limit, `Core.consentAllowsAnalytics`,
  the ref validators, the schema-default checkbox form, the maintenance-tick
  retention path, and the compliance handler.

## Tables + RLS (migration 0013)
`analytics_event` (partitioned parent), its monthly partitions, `analytics_settings`,
`analytics_rollup_daily` — all tenant tables: `shop_id` FK (`ON DELETE CASCADE`),
**RLS ENABLED + FORCED**, policy `shop_id = app_current_shop()`. Grants to
`app_runtime` on the parent + the two helper tables only; **never on a
partition**. Additive + idempotent (`CREATE … IF NOT EXISTS`, `DROP POLICY IF
EXISTS`, `CREATE OR REPLACE FUNCTION`, `to_regclass` guard). Verified applied with
RLS enabled+forced on the parent and each partition. Not modelled in Prisma
(raw SQL under `withShop`, like Phases 8–10); erased explicitly on shop/redact.

## Tests vs 416
Full suite **477 passed | 13 skipped** (was 416 | 11 at base). Every
previously-passing test still passes; none weakened. **+61** Phase 11 tests:
- `phase11-units` (25) — PII redaction (emails/phones/cards/URLs/tokens, and a
  phone that must not survive the length bound), event validation (unknown keys,
  bad enums, malformed gid/uuid/session, out-of-range ints, client-`ts` ignored,
  batch cap), A/B z-test (known z, zero/all-or-nothing denominators → null,
  thresholds, `variantStats` zero-guard), attribution (window, session-less
  ignored, order-independent), CSV (neutralize `= + - @` TAB/CR, RFC-4180 escape,
  hostile query text, row cap), customer-events mapping (checkout_completed →
  null, malformed id dropped).
- `phase11-engine` (10) — mode off stores nothing; anonymous strips session id;
  consented keeps it; **server stamps occurred_at (client ts ignored)**; mixed
  valid/invalid batch; reports correct on a seeded set (window applied);
  **report query counts (summary 2, list 1)**; window + retention purge;
  delete-all; FK cascade on shop delete.
- `phase11-partitions-rls` (9) — partitions created idempotently; Dec→Jan +
  leap-day boundaries; old partition dropped/recent kept; **RLS enabled+forced on
  parent AND every partition**; cross-shop invisibility via the parent;
  **`app_runtime` cannot read/write a partition directly**; hostile ingestion
  input never throws; other-shop product gid is opaque text; oversized batch
  capped.
- `phase11-abtest-engine` (2) — per-variant aggregation + significant z above
  threshold; below-threshold inconclusive, over a seeded event set.
- `phase11-extension` (11) — emitter present + loaded by every emitting block;
  no `innerHTML`; **consent checked before any sessionStorage**; sends via
  sendBeacon/fetch keepalive; per-block toggle in the schema-default form; locale
  parity.
- `phase11-mutation` (4) — **mutation tests of 3 guards**: an unregistered route
  is caught by the routing guard; a wrong default-false checkbox form is caught;
  sessionStorage before the consent check is caught; plus a meta-check that the
  real tree is unmodified.
- `prisma-integration` — 2 added CI-only cases (analytics ingest + report via the
  production Prisma path; unsigned `proxy/analytics-event` → HTTP 400) that
  self-skip in the egress-blocked sandbox (the +2 skips).

`npm run typecheck`, `npm run build`, `npm run worker:build`, locale parity and
the Phase 7 routing guard (covers the 3 new routes) are all green.

## Deviations
- A client `ts` field is permitted in the payload (then ignored) rather than
  rejected as an unknown key, so a storefront that includes one does not lose the
  whole event; `occurred_at` is still always server-stamped. Documented.
- `analytics_rollup_daily` is defined and retained/purged, but population is left
  to a future rollup job — reports read raw events within the window directly, so
  no report depends on the rollup yet. Documented as optional.

## Known limitations
- The ingestion beacon is public and inflatable; counts are advisory (Phase 11
  analytics does not supersede a real server-truth metric).
- Purchase/revenue attribution and Web Pixel delivery are not implemented (pure
  unwired modules only).
- No rollup backfill job yet (see Deviations).

## Live-Prisma status
**Pending.** `binaries.prisma.sh` is egress-blocked in this sandbox, so the suite
is pg-verified via node-postgres (identical SQL) and the production Prisma path
is exercised by the self-skipping `prisma-integration` cases on hosted CI.

## Requires Verification
Web Pixel extension + `write_pixels`/`read_customer_events` (pixel sandbox +
customer-privacy/consent); purchase/revenue attribution (order data); live App
Proxy beacon + consent on a real storefront; live theme rendering of the
emitters. Performance/benchmarks are Phase 14 — not claimed here.

## Next step
Awaiting independent verification + live-Prisma CI confirmation for the Phase 11
line. Phase 12 is **not** started.

## STATUS
PHASE 11 IMPLEMENTED & PG-VERIFIED (477 passed | 13 skipped). LIVE-PRISMA
CONFIRMATION PENDING. PHASE 12 NOT STARTED.
