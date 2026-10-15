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

## Phase 11.1 — fix batch (over Phase 11)

Three findings from the Phase 11 review, fixed on top of `c6ba65a`. Migration 0013
is untouched; everything ships as the additive, idempotent migration
`0014_phase11_1_definer_hardening`.

### N1 (CRITICAL — cross-tenant data destruction via SECURITY DEFINER)

**Failing input:** as `app_runtime`, from any shop-scoped context,
`SELECT app_drop_analytics_partitions_before('2100-01-01')` dropped **every**
monthly partition of `analytics_event`, destroying all rows for **all** shops;
`app_ensure_analytics_partition('9999-01-01')` (and `'1900-01-01'`, far-future
months) created unbounded partitions. The functions trusted their `timestamptz`
argument.

**New behaviour (migration 0014, enforced in the database — defence in depth):**
- `app_drop_analytics_partitions_before(p_cutoff)` computes a hard floor
  `date_trunc('month', nowUTC − 395 days)` from the **real server clock** and uses
  `effective = LEAST(requested, floor)`. No argument can drop a partition newer
  than the 395-day cap. Normal tick use (`cutoff = now − 395d`) is unchanged.
- `app_ensure_analytics_partition(p_month)` accepts only months in
  `[current − 14, current + 3]` (UTC); anything else raises `22023` and creates
  nothing.
- Both keep `SECURITY DEFINER` + `SET search_path`, `REVOKE ALL FROM PUBLIC`,
  `GRANT EXECUTE` to `app_runtime` only, and carry the threat-model comment.
- The complete SECURITY DEFINER surface `app_runtime` can execute is audited in
  `docs/PHASE11.md` (table below), and a test enumerates the catalog and fails if
  any definer function executable by `app_runtime` is not in the explicit
  allowlist. A second test asserts `app_analytics_hard_retention_days()` (SQL) ==
  `PARTITION_RETENTION_DAYS` (app) == 395.

| Function | Definer action | Cross-tenant surface | Why safe |
| --- | --- | --- | --- |
| `app_resolve_shop(text)` | upsert + return shop id | writes one shop row; returns its UUID | domain→id bootstrap; no tenant data read |
| `app_shops_needing_full_sync()` | read shop sync flags | shop UUIDs + flags | scheduling metadata only |
| `app_list_analytics_partitions()` | read catalog | partition names | metadata only |
| `app_analytics_hard_retention_days()` | return `395` | none | pure constant |
| `app_ensure_analytics_partition(timestamptz)` | DDL create | creates RLS-forced, un-granted partition | range-bounded `[now−14, now+3]` else `22023` |
| `app_drop_analytics_partitions_before(timestamptz)` | DDL drop (destructive) | drops partitions | hard-floored `LEAST(requested, now−395d)` |

**Tests (`test/phase11_1-definer.test.ts`, as `app_runtime`, both shops holding
events):** drop `'2100-01-01'` destroys nothing and both shops keep their data; a
genuinely-old cutoff drops only the old partition; ensure `9999`/`1900`/`now+4mo`/
`now−15mo` all raise and create nothing; ensure `now`/`+1`/`+2`/`+3`/`−14mo` work
and are idempotent; the allowlist + retention-constant tests above. The partition
maintenance tick and ingestion still pass (`test/phase11-partitions-rls.test.ts`,
reworked to real-clock months because the hardened functions anchor to real `now`).

**Mutation test (performed):** removing the `LEAST` clamp via `CREATE OR REPLACE`
and re-running the exploit-defeat test made `drop('2100-01-01')` drop every
partition (`after == []`, both shops wiped) and the test **failed** as expected;
re-applying migration 0014 restored the clamp and all 7 N1 tests pass again.

### N2 (MUST — PII redaction was evadable)

**Failing input:** `cleanQuery` redacted the **raw** text, then normalized; but the
normalizer strips zero-width/format chars and folds full-width/Arabic-Indic digits,
so obfuscated PII that did not match a pattern raw became a clean digit run **after**
redaction and was stored unredacted — e.g. `4111​1111​1111​1111` (zero-width),
`４１１１１１１１１１１１１１１１` (full-width card), `415‌555‌1234` (ZWNJ phone),
`٤١٥٥٥٥١٢٣٤` (Arabic-Indic phone), `john.doe＠example.com` (full-width `@`),
`john.doe@ex​ample.com` (zero-width in domain).

**New behaviour:** canonicalize **before** redacting (NFKC, strip invisible/format
chars, fold every `\p{Nd}` to ASCII, full-width `@`/`.`→ASCII), redact the canonical
text, then `normalizeQuery`, then **redact again** on the normalized string;
Unicode-aware email pattern; pre-bounded to 4000 chars; idempotent; never throws.
The same redaction is applied to string values in event `properties`. Documented
non-detections (names, addresses, spelled-out emails) and the accepted 8+-digit-SKU
false positive are in `docs/PHASE11.md`.

**Tests (`test/phase11-units.test.ts`):** the exact probe inputs each → `[redacted]`
with `redacted=true`; a table test over every separator × invisible combination for
a card and a phone; false-positive guards stay unredacted (`iphone 15 pro max 256gb`,
`ps5 2024 slim`, `size 10 shoes`, `2 pack`, `iphone 15`); existing redaction tests
unchanged.

### N3 (NIT — CSV neutralization past leading whitespace)

**Failing input:** a cell whose first **non-whitespace** char is a formula lead was
not neutralized — `" =1+1"`, `"  @x"` were emitted as-is (some apps trim then
evaluate).

**New behaviour:** `DANGEROUS_PREFIX` now skips leading whitespace
(`/^[ \t\r\n]*[=+\-@\t\r]/`), so a formula hidden behind a leading space/tab/CR is
neutralized with a leading `'`. Existing behaviour and RFC-4180 escaping are
unchanged; leading space/tab/CR variant tests were added.

### Gates

`typecheck` clean, `build` ok, `worker:build` ok. Full suite **511 passed | 13
skipped** (up from the Phase 11 baseline of 477 | 13; +34 new tests, 13 skipped
unchanged, none weakened).

## Requires Verification
Web Pixel extension + `write_pixels`/`read_customer_events` (pixel sandbox +
customer-privacy/consent); purchase/revenue attribution (order data); live App
Proxy beacon + consent on a real storefront; live theme rendering of the
emitters. Live-Prisma CI confirmation still pending for the Phase 11/11.1 line.
Performance/benchmarks are Phase 14 — not claimed here.

## Next step
Awaiting independent verification + live-Prisma CI confirmation. Phase 12 is
**not** started (no approval).

## STATUS
PHASE 11.1 IMPLEMENTED & PG-VERIFIED (511 passed | 13 skipped; Phase 11 baseline
477 | 13, none weakened). LIVE-PRISMA CONFIRMATION PENDING. PHASE 12 NOT STARTED.
