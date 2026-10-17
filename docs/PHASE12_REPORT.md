# Phase 12 Report — Back-in-stock, pre-order, countdown, email

**Base:** `53591ab` (Phase 11.1). **Scope:** 12.1–12.8 as specified. **Status:**
Implemented & PG-verified. Live-Prisma CI confirmation **pending**. Phase 13 **not**
started. No performance numbers are claimed (Phase 14).

> Part of this phase's server code was produced in a prior (interrupted) session
> and left uncommitted on disk. This session audited every module against the full
> spec, **built the missing storefront theme layer** (three app blocks + their JS +
> locales + a `/proxy/preorder` endpoint), wrote the **entire Phase 12 test suite**,
> performed the mutation tests, verified the build/suite, wrote the docs, and
> committed/packaged it. Findings from the audit: the server implementation matches
> the spec in the details checked; the gaps were the theme blocks and tests.

## Design decisions

- **Email with zero new dependencies.** `SmtpEmailProvider` is hand-written on
  `node:net`/`node:tls`. The socket factory (`connect`/`upgrade`/`sleep`) is
  injectable so the full SMTP state machine is tested against an in-process fake
  server with no OS sockets. Typed `PermanentEmailError` (5xx / malformed) vs
  `TransientEmailError` (4xx / network / timeout) drives retry-vs-bounce.
- **Email handling is pure + validated before any network I/O.** `mime.ts` builds
  and injection-checks the whole message (CR/LF/NUL rejection, RFC 2047 subject,
  bare-address-only, 256 KB cap, allowlisted headers, dot-stuffing) and throws
  `EmailValidationError` (permanent) before a socket is opened.
- **Secrets.** SMTP passwords are AES-256-GCM encrypted at rest; the key is
  required to save a password (else nothing is written); the password is write-only
  (never returned/logged; admin sees `configured` + last 2 chars). Shopper emails
  are looked up by a **keyed, shop-scoped HMAC** so the plaintext is only ever
  touched to actually send — never queried, logged, or put in jobs/analytics.
- **Idempotency without a new scope.** Restock detection reuses the synced catalog;
  a per-target monotonic **availability epoch** (Phase 2.1 rule) plus a unique
  `(shop, subscription, epoch)` ledger make webhook replays / out-of-order webhooks
  safe. The fan-out is one **set-based** insert per transition (does not grow per
  subscriber). The drain is a per-shop **singleton** job carrying only the shop id,
  re-checking availability/visibility/suppression/status **at send time**.
- **Additive, byte-identical when idle.** Pre-order card annotation and the detect
  hook are no-ops (an existence check / an empty-rule early return) when a shop has
  no rules/subscribers, so existing payloads and behaviour are unchanged.
- **Display-only pre-order & countdown.** Neither touches price or checkout; the
  docs/admin state plainly that purchasability is the merchant's Shopify config.

## New tables (migration 0015) + RLS

All eight are tenant tables: `shop_id` FK, **RLS ENABLED + FORCED**, policy
`shop_id = app_current_shop()`, grants to `app_runtime` only. **No SECURITY
DEFINER function is added** (detection/reads/writes run as `app_runtime` under RLS
over tables that are already tenant tables) — the Phase 11.1 definer allowlist test
still passes unchanged.

| Table | Purpose |
|---|---|
| `email_setting` | per-shop SMTP config; password AES-256-GCM ciphertext |
| `restock_setting` | per-shop caps + retention window |
| `back_in_stock_subscription` | subscriptions; normalised email + keyed hash; hashed tokens; double-opt-in state |
| `restock_availability` | per-target availability + monotonic epoch + `last_source_at` guard |
| `restock_notification` | idempotent send ledger, unique `(shop, subscription, epoch)`; **no email column** |
| `restock_suppression` | minimal hashed-email suppression (unsubscribed/bounced/retention) |
| `preorder_rule` | display-only pre-order messaging rules |
| `countdown_rule` | display-only countdown rules |

## Tests (vs the 511 baseline)

**Full suite: 587 passed | 13 skipped** (58 files), up from the Phase 11.1 baseline
of **511 passed | 13 skipped** (53 files). All 511 prior tests still pass; the 13
skips (CI-only Prisma-integration cases) are unchanged; none were weakened. Five new
Phase 12 test files add **73** tests:

- `phase12-smtp.test.ts` (15) — SMTP client vs the in-process fake server (EHLO,
  STARTTLS re-EHLO, AUTH PLAIN + AUTH LOGIN, 5xx permanent / 4xx transient /
  timeout, dot-stuffing, header-injection + oversized rejected before any socket)
  and pure MIME/RFC-2047/injection units.
- `phase12-units.test.ts` (19) — AES-GCM round-trip/tamper/missing-key; keyed email
  hash + token gen/hash/verify/derive; email normalisation (unicode/full-width,
  CR/LF/NUL, length, no display-name) + masking; templates (en/fr, escaped);
  `safeHttpsUrl`; unsubscribe/confirm URL shape + one-click header; countdown math
  (injected clock, skew, specificity, expiry); pre-order schedule boundaries
  (start-inclusive/end-exclusive) + specificity.
- `phase12-engine.test.ts` (16) — subscribe→confirm lifecycle; unavailable-only;
  dedupe + identical response; hostile input (bad/huge/SQLi email, bad gid,
  consent-missing) never throws/leaks; per-email & per-shop caps; suppression;
  idempotent unsubscribe; tampered/expired tokens; restock transition + replay
  (monotonic guard) ; one-send + flip to notified; **send-time re-check**; permanent
  bounce→suppress; transient→still-pending; and **query counts** (subscribe = 6;
  fan-out = **1 query for 21 subscribers**; countdown/preorder lookups = 1 each).
- `phase12-privacy.test.ts` (10) — RLS enabled+forced on all 8 tables; cross-shop
  isolation on every table; WITH CHECK blocks a foreign-shop insert; credentials
  ciphertext at rest + view exposes no password; refuse-without-key; the ledger has
  no email column (only `back_in_stock_subscription` holds plaintext `email`);
  retention purge (unconfirmed 7d, terminal→suppression, bounded batch, injected
  clock); GDPR count + idempotent delete-by-hash with ledger cascade.
- `phase12-extension.test.ts` (13) — the three new blocks + JS exist and load
  core + their JS + default proxy apps/search; **no innerHTML/outerHTML/
  insertAdjacentHTML** in any new or card JS; consent checkbox present and **not
  pre-ticked**, text from locales; notify JS requires consent + valid email;
  countdown uses `serverNow`/skew, `prefers-reduced-motion`, coarse aria,
  aria-hidden clock; **locale parity** incl. the new keys.

Routing-guard coverage (`phase7-routing`) auto-covers the new routes
(`proxy/preorder` and the six prior Phase 12 routes) — each `app/routes/*.tsx` must
be registered exactly once; the suite passes.

### Mutation tests (performed)

Two of our own guards were mutated, the targeted test shown to fail, then restored:

1. **Send-time availability re-check** (`drainRestockNotifications`): replacing
   `if (!eff.visible || !eff.available)` with `if (false)` made the drain mail a
   product that had sold out again — `send-time re-check` test **failed**
   (`prov.sent.length` 0 → 1). Restored → passes.
2. **One-send idempotency flip** (`status='notified'`): removing the flip left the
   subscription `confirmed` — the `drain sends exactly one … flips to 'notified'`
   test **failed** on `status === "notified"`. Restored → passes.

## Gates

`npm run typecheck`, `npm run build`, `npm run worker:build`, and
`scripts/check-locale-parity.mjs` all pass.

## Deviations

- **`/proxy/preorder` endpoint added** (not named explicitly in the spec) so the
  pre-order **product block** has a data source symmetric with `/proxy/countdown`;
  the card mechanism remains the additive payload as specified. Registered + under
  the routing guard + hostile-input/never-5xx via the same `handleProxy` wrapper.
- Pre-order release dates render in the **browser's** locale/timezone in the theme
  (the server stores UTC); precise shop-IANA-tz formatting in the block is a display
  refinement (Requires Verification on a live theme).
- The compliance (`customers/*`, `shop/redact`) **Prisma** wiring is exercised on CI
  (`prisma-integration`); the engine tests verify the identical SQL behaviour
  (count-by-hash, idempotent delete + ledger cascade, suppression) via node-postgres,
  consistent with the project's pg-verification strategy.

## Known limitations / Requires Verification

- The app does **not** make an out-of-stock product purchasable — selling plans /
  continue-selling / checkout changes are the merchant's Shopify configuration and
  need unapproved scopes / a Shopify Function.
- Real email **deliverability** (SPF/DKIM/DMARC, domain reputation, PTR, outbound
  SMTP egress on 25/465/587, provider quirks) is the merchant's responsibility.
- Live **App Proxy** signature + the storefront blocks' DOM behaviour (fetch,
  variant-change, timer rendering, consent box) on a **real theme/store**.
- Live-Prisma CI confirmation for the Phase 12 line.

## Live-Prisma status

**PENDING** (`binaries.prisma.sh` is egress-blocked in this sandbox →
pg-verified via node-postgres with identical SQL; the production Prisma path is
exercised by the self-skipping CI cases).

## Next step

Awaiting independent verification + the live-Prisma GitHub Actions run. Phase 13 is
**not** started (no approval).

## STATUS

PHASE 12 IMPLEMENTED & PG-VERIFIED (587 passed | 13 skipped; Phase 11.1 baseline
511 | 13, none weakened). LIVE-PRISMA CONFIRMATION PENDING. PHASE 13 NOT STARTED.
