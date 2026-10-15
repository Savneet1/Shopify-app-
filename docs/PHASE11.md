# Phase 11 — Analytics (design & exact rules)

First-party, privacy-first search analytics computed entirely in PostgreSQL. **No
new Shopify scope, no Web Pixel extension, no external analytics service, no new
npm dependency, no new PostgreSQL extension. `docInsertSql` unchanged.** **No IP
addresses, no user-agents, no fingerprints, and no customer identifiers are ever
stored.** Analytics is **OFF by default** (opt-in per shop); with it off, every
existing search/merch/recommendation/bundle behaviour is byte-identical to before
Phase 11.

## 11.1 Event model + storage

`analytics_event` is **RANGE-partitioned by month on `occurred_at`**.
`occurred_at` is **always the server clock** — the ingestion path never trusts a
client timestamp (a `ts` field in the payload is accepted only so the
unknown-keys check passes, then ignored).

Columns (all bounded/typed, closed enums enforced by `CHECK`): `shop_id`,
`event_type`, `occurred_at`, `session_id` (nullable, `^[A-Za-z0-9_-]{1,64}$`),
`query_norm` (nullable, ≤100 chars), `query_redacted` (bool), `result_count`
(0–1e8), `product_gid` (nullable, `gid://shopify/Product/<n>`), `position`
(0–100000), `experiment_id` (uuid, nullable), `variant` (A|B|control),
`surface` (`search_page|predictive|recommendation|bundle|redirect`),
`properties` (bounded jsonb, ≤2000 bytes, scalar values only). PK is
`(occurred_at, id)` (the partition key must be in the PK).

**Event types** (closed set): `search_performed`, `search_zero_result`,
`result_click`, `predictive_click`, `suggestion_click`, `redirect_followed`,
`add_to_cart_from_search`, `recommendation_click`, `bundle_add_to_cart`,
`filter_applied`.

**RLS is ENABLED + FORCED on the parent AND on every partition.** `app_runtime`
holds DML on the **parent only** — it is granted nothing on any partition, so a
partition cannot be read or written directly; all access is routed through the
parent, where the `shop_id = app_current_shop()` policy applies. Partition DDL is
done by **owner-owned `SECURITY DEFINER` functions** (`REVOKE ALL … FROM PUBLIC`,
`GRANT EXECUTE … TO app_runtime`): `app_ensure_analytics_partition(month)`
(idempotent create + RLS + policy, no grant), `app_drop_analytics_partitions_before(cutoff)`,
`app_list_analytics_partitions()`. There is **no DEFAULT partition** — nothing
silently accumulates; an out-of-range insert with no matching partition errors
loudly, and the ingestion path always ensures the current month first.

**Partition maintenance** runs from the existing maintenance tick (owner/root
path, like signal retention): ensure the current + next 2 months idempotently,
and drop partitions entirely older than the hard cap (`PARTITION_RETENTION_DAYS =
395`, the max configurable retention, so a dropped partition can never still be
needed by any shop's window). Tested with an injected clock: idempotent creation,
Dec→Jan and leap-day boundaries, old-partition drop, run-twice no-op.

## 11.2 Privacy

Per-shop `analytics_settings.mode ∈ off | anonymous | consented_sessions`
(**default `off`**, opt-in), `retention_days` (default 90, **max 395**). RLS
tenant table.
- **off** → accept nothing, store nothing.
- **anonymous** → store events with **no** session id (a session id sent by the
  storefront is stripped at validation).
- **consented_sessions** → keep a random short-lived first-party session id,
  created **only** when `Core.consentAllowsAnalytics(...)` is true (fail-closed,
  the same gate as Phase 8.1) and dropped when consent is denied/withdrawn.

**Query-text hygiene:** redact likely PII from the **raw** text *before*
normalizing (the normalizer strips the punctuation that makes PII detectable),
then normalize and hard-bound to 100 chars. Redacted: emails, URLs/`www.` tokens,
card-like 13–19-digit runs (allowing spaces/dashes), phone-like ≥7-digit runs,
and long opaque tokens (≥20 chars) → replaced with `[redacted]` and the
`query_redacted` flag set. The original is never stored.

**Compliance** (verified against `webhooks.compliance.server.ts`): analytics
events carry **no customer identifiers**, so `customers/data_request` and
`customers/redact` have nothing to return or erase → recorded as `no_data`.
`shop/redact` and uninstall erase all analytics rows (explicit `DELETE` of
`analytics_event` / `analytics_rollup_daily` / `analytics_settings`, and the
`shop` FK is `ON DELETE CASCADE` as a backstop). Admin "Delete all analytics
data" (own shop, typed `DELETE` confirmation) wipes the shop's rows.

The ingestion beacon is **public and inflatable** — the counts are advisory, not
authoritative.

## 11.3 Ingestion

App Proxy `proxy/analytics-event` (signed via `handleProxy`, per-shop rate limit,
never-5xx). Accepts a JSON body `{ events: RawEvent[] }`, **≤20 events**, with a
**16 KB body-size cap** (oversize → whole batch rejected). Every field of every
event is validated **before any SQL** (closed enums, gid/uuid/session formats,
bounded ints, **unknown keys rejected**, scalar-only properties); invalid events
are dropped **individually** (valid ones in the same batch still store). Respects
`analytics_mode` (off → stores nothing). Returns `{accepted, rejected}`. Never
throws / never 5xx on hostile input. The current month's partition is ensured
(idempotent definer call) before insert; `occurred_at` is the server clock.

**Storefront emitters** are added to the existing results block, predictive
embed, recommendations block and bundle block as fire-and-forget batched
`sendBeacon`/`fetch(keepalive)` with a timeout, consent-gated session id, a
per-block merchant toggle in the schema-default-aware checkbox form, and a silent
no-op on failure. **No analytics rows are written on the server-side search hot
path.**

## 11.4 Reporting

Parameterized queries over `analytics_event`, **always with a date window** and
**always clamped to the shop's retention** (a report can never read past what
retention keeps); all RLS-scoped. Reports: searches, zero-result rate, CTR, top
queries, top zero-result queries, queries with no clicks, add-to-cart-from-search
rate, redirect usage, per-surface breakdown, daily trend.

**CTR is the session-free definition** (documented): `CTR = (result_click +
predictive_click + suggestion_click + recommendation_click) / search_performed`
over the window — a ratio of event counts, not a per-session rate.

**Query counts** (hot path = dashboard summary): `summaryReport` = **2 queries**
(1 to load settings + resolve/clamp the window, 1 aggregate); each list report
(`topQueries`, `topZeroResultQueries`, `queriesWithNoClicks`, `perSurface`,
`dailyTrend`) = **1 aggregate query** after the window is known. No timing numbers
are claimed (Phase 14).

Optional `analytics_rollup_daily` (per shop/day/event_type/surface counts, **no
raw query text**) for long-range trend with its own retention (`ROLLUP_RETENTION_DAYS
= 400`) purged on the maintenance tick.

Retention runs on the existing tick (Phase 9.1/10 pattern): per-shop bounded-batch
row purge of `analytics_event` older than the shop's `retention_days` and of
`analytics_rollup_daily` older than the rollup cap, plus the global partition job.

## 11.5 A/B readout

Extends Phase 8's aggregate counters using the events' `experiment_id`/`variant`
tags: per-variant searches, clicks, CTR and add-to-cart rate, with a **two-
proportion z-test** (pooled) comparing arms — shown **only** when both arms clear
the documented minimum-sample thresholds (`MIN_TRIALS_PER_ARM = 100`,
`MIN_SUCCESSES_PER_ARM = 10`); below them it reports "inconclusive — not enough
data" and no z. Significant at `|z| ≥ 1.96` (two-sided p < 0.05). Zero
denominators (and all-success/all-failure pooled) return `null`. It **never**
claims causal lift or revenue (no order data). Pure, deterministic, unit-tested
with known z values, thresholds and zero denominators.

## 11.6 Attribution

Pure, tested, last-click attribution within a single consented session
(`DEFAULT_SESSION_WINDOW_MIN = 30`, configurable): links an
`add_to_cart_from_search` to the most recent preceding click of the **same
product** in the **same session** within the window. Session-less (anonymous)
events are ignored; order-independent and deterministic.

**Purchase/revenue attribution is NOT implemented** (no order data, no scopes).
An **unwired** mapping module (`customer-events.ts`) maps Shopify standard
customer events → our schema: `search_submitted → search_performed`,
`product_added_to_cart → add_to_cart_from_search` (Product GID kept only when
well-formed), `checkout_completed → null` (intentionally unmapped). It is pure
and tested but wired to nothing.

**What a real Web Pixel would need (Requires Verification, needs explicit
approval):** a Shopify **Web Pixel extension**, the **`write_pixels`** and
**`read_customer_events`** scopes, and handling of the pixel sandbox + customer
privacy/consent (the pixel runs in a sandbox and must respect the customer
privacy API; a `clientId` would never be persisted as-is). None are approved;
none are added.

## 11.7 Admin

`/app/analytics` (registered, routing-guard-covered): enable/mode/retention
settings, a date-range picker, the reports above rendered as **dependency-free
inline-SVG/CSS** charts built from `textContent`/escaped values, the A/B readout,
and "Delete all analytics data" (own shop, typed-`DELETE` confirmation). CSV
export routes (`/app/analytics/export`) for queries, zero-result queries and raw
events with a **hard row cap**, streaming-safe, and **CSV/formula-injection
protection** — a cell starting with `= + - @` TAB or CR is neutralized with a
leading `'`, and quotes/commas/newlines are escaped per RFC 4180 — tested
including hostile query text.

## What is and is NOT implemented

- **Implemented (FULLY, first-party):** event model + monthly partitioning with
  parent+partition RLS, opt-in privacy modes, PII redaction, batch ingestion
  endpoint + storefront emitters, reporting + rollup + retention, A/B z-test
  readout, pure last-click session attribution, admin dashboard + CSV export.
- **NOT implemented:** purchase/revenue attribution and any Web Pixel delivery of
  Shopify customer events — these need `write_pixels` + `read_customer_events` (and
  for revenue, order data / `read_orders`), all **Requires Verification** and
  unapproved. The mapping module is present but unwired.

## Phase 11.1 — hardening (migration 0014)

Phase 11.1 is a security/privacy fix batch over Phase 11. Migration 0013 is **not**
modified; the fixes ship as the additive, idempotent `0014_phase11_1_definer_hardening`
(`CREATE OR REPLACE` only — no table or data change), so an already-migrated database
picks them up on deploy.

### SECURITY DEFINER audit

A `SECURITY DEFINER` function runs with the **owner's** privileges and bypasses RLS
for whatever it does internally, so every definer function that `app_runtime` (the
NOSUPERUSER / NOBYPASSRLS role every request handler and the worker run as) may
`EXECUTE` is a potential cross-tenant hole. The table below is the **complete** set
`app_runtime` can execute; a test (`test/phase11_1-definer.test.ts`) enumerates the
catalog and fails if any definer function executable by `app_runtime` is missing
from this allowlist, forcing this audit to stay current.

| Function | Definer action | Cross-tenant read / write / delete surface | Why it is safe |
| --- | --- | --- | --- |
| `app_resolve_shop(text)` | Upserts a `shop` row for a domain, returns its id | Writes one `shop` row; returns only that shop's opaque UUID | Domain→id bootstrap is the intended behaviour; reads/returns no tenant business data and no other shop's row |
| `app_shops_needing_full_sync()` | Reads `shop` sync metadata | Returns a list of shop UUIDs + sync flags (no per-tenant catalog/analytics rows) | Worker scheduling metadata only; opaque ids, no tenant data crosses a boundary |
| `app_list_analytics_partitions()` | Reads `pg_catalog` | Returns partition **names** (catalog metadata) | Names only; no row in any partition is read |
| `app_analytics_hard_retention_days()` | Returns the integer `395` | None | Pure IMMUTABLE constant |
| `app_ensure_analytics_partition(timestamptz)` | **DDL** — creates a monthly partition | Creates a partition (+ forces RLS, adds the tenant policy, grants nothing) | **Range-bounded to `[now−14, now+3]` months** (else raises `22023` and creates nothing); creates an RLS-FORCED, un-granted partition reachable only via the parent — never reads or destroys data |
| `app_drop_analytics_partitions_before(timestamptz)` | **DDL** — drops whole monthly partitions (destructive) | Drops partitions, destroying all shops' rows in them | **Hard-floored**: effective cutoff = `LEAST(requested, date_trunc('month', nowUTC − 395d))`, computed from the real server clock — so no argument, in any tenant context, can drop a partition that could hold data newer than the 395-day cap. The current partition and recent data always survive |

The two DDL functions were the N1 vulnerability: as shipped in 0013 they trusted
their `timestamptz` argument, so `app_runtime` could call
`app_drop_analytics_partitions_before('2100-01-01')` and drop **every** partition
for **every** shop (cross-tenant data destruction), or create unbounded far-future
partitions. 0014 enforces both bounds **inside** the functions (defence in depth —
the app never passes a hostile value, but callers are not trusted). The guard is
mutation-tested: removing the clamp makes the exploit-defeat test wipe both shops'
data and fail; restoring it passes.

### PII redaction — what is and is NOT detected (N2)

Redaction now **canonicalizes before redacting** (NFKC, strip invisible/format
characters = `Cf` + `U+00AD/200B–200F/2060/FEFF`, fold every `\p{Nd}` to ASCII, map
full-width `@`/`.` to ASCII) and redacts **again after** `normalizeQuery`, so a run
only visible after punctuation-folding is still caught. String values in event
`properties` get the same treatment via `redactValue`.

- **Detected (redacted to `[redacted]`):** emails (Unicode/IDN local + domain,
  full-width `@`, zero-width-split), URLs (`http(s)://`, `www.`), card-like runs
  (13–19 digits) and phone-like runs (7+ digits) **however separated** — spaces,
  dashes, parens, zero-width/soft-hyphen/word-joiner/BOM, and full-width or
  Arabic-Indic (and other scripts') digits; long opaque tokens (≥20 chars).
- **NOT detected (accepted limitations):** personal **names** ("john smith"),
  **postal addresses** ("123 main street"), and **spelled-out** contact info
  ("john at example dot com") — these are not pattern-detectable without heavy NLP
  and are out of scope.
- **Accepted false positive:** a bare digit run of 8+ digits (e.g. a long SKU) is
  redacted. We prefer occasionally redacting a long SKU over ever leaking a phone
  or account number. Short product tokens stay intact ("iphone 15 pro max 256gb",
  "ps5 2024 slim", "size 10 shoes", "2 pack", "iphone 15" are **not** redacted).

Redaction is idempotent, bounded (input pre-truncated to 4000 chars), and never throws.

### Retention-constant single source of truth

The hard partition-retention cap lives once in SQL as
`app_analytics_hard_retention_days()` (= `395`). The app constant
`PARTITION_RETENTION_DAYS` (`app/lib/analytics/settings.ts`) must equal it; a test
reads both and asserts they agree, so the DB floor and the maintenance-tick cutoff
can never silently drift apart.

## Requires Verification
Web Pixel extension + `write_pixels`/`read_customer_events` (pixel sandbox +
customer-privacy/consent behaviour); purchase/revenue attribution (order data);
live App Proxy beacon + consent on a real storefront; live theme rendering of the
emitters. Benchmarks are Phase 14 — no performance numbers are claimed.
