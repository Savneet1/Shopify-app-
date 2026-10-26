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

## Phase 12.1 — fix batch (over Phase 12)

Four findings from the Phase 12 review, fixed on top of `a709ff2`. Migration 0015
is untouched; the schema change ships as the additive, idempotent migration
`0016_phase12_1_pepper`. No new scope, dependency, extension or SECURITY DEFINER
function.

### Q1 (HIGH — SMTP SSRF / internal port-scan oracle)

**Failing input:** the merchant-controlled SMTP host/port were used with no
destination policy. Measured: `127.0.0.1:5432` → connected and hung ~45 s waiting
for a greeting; `127.0.0.1:5999` (closed) → `ECONNREFUSED` in ~305 ms; `localhost`,
decimal `2130706433`, hex `0x7f000001` all reached loopback; `no-such-host.invalid`
→ `ENOTFOUND`. Refused-vs-hang-vs-ENOTFOUND plus the echoed internal `IP:port` was a
network-mapping oracle, reachable through the public subscribe flow.

**New behaviour** (`app/lib/email/destination.ts`, applied at **save** and
authoritatively at **every connect**):

| Layer | Rule |
| --- | --- |
| Host shape | a conservative DNS hostname (labelled, length-bounded, alpha TLD ≥2, no trailing dot) **or** a canonical IP literal (`net.isIP`). Rejects decimal/hex/octal/short-form IPs, userinfo, port-in-host, brackets, whitespace/control chars |
| Port | `25`, `465`, `587`, `2525` only (constant) |
| TLS consistency | `465` ⇒ implicit TLS; credentials ⇒ TLS (STARTTLS or implicit) — never AUTH over `none` |
| Resolve + pin | at connect, `dns.lookup(all:true)` (injectable); **reject if ANY resolved address is non-public** (IPv4 `0/8,10/8,100.64/10,127/8,169.254/16,172.16/12,192.0.0/24,192.0.2/24,192.168/16,198.18/15,198.51.100/24,203.0.113/24,224/4,240/4`; IPv6 `::,::1,fc00::/7,fe80::/10,ff00::/8,2001:db8::/32` + v4-mapped/NAT64/6to4/Teredo embedded v4); then **connect to the pinned IP**, hostname only for TLS SNI + `rejectUnauthorized:true` — defeats DNS rebinding |
| Errors | generic categories only (`could not connect`, `TLS failed`, `authentication failed`, `server rejected the message`, `destination not allowed`); **no IP/port/errno/banner** in merchant-visible messages or logs. Policy violations are **permanent** (no retry/no 45 s hang); a short connect/greeting timeout is independent of the whole-send timeout |
| Dev escape | `SMTP_ALLOW_PRIVATE_HOSTS` for local dev only; **ignored under `NODE_ENV=production`** (one-time warning) |

**Tests (`phase12-ssrf`):** every probe (`127.0.0.1`, `localhost`, `::1`,
`::ffff:127.0.0.1`, `2130706433`, `0x7f000001`, `169.254.169.254`, `10/172.16/192.168/100.64`,
a hostname resolving to a private address, one-public+one-private, ports
`22/80/5432/6379/8080`, AUTH-over-`none`) is **rejected with the injected connect
NOT called**; a DNS-rebinding resolver (public then private) resolves once and
pins the public IP; allowed public IP on `25/465/587/2525` connects to the pinned
IP; error text contains no IP/port/errno. **Mutation:** disabling the pin made 14
internal-address probes connect — the SSRF tests failed; restored → pass.

### Q2 (HIGH — existence timing oracle + slow SMTP inside a public request)

**Failing input:** `proxy/back-in-stock` awaited the confirmation send inline, only
when a row was CREATED → new address ~319 ms vs already-subscribed ~3–5 ms (a
60–100× oracle contradicting "never reveals"), and a slow/hanging SMTP host held
the request up to ~45 s.

**New behaviour:** **no outbound I/O in the public request.** A freshly created row
only **enqueues** a pg-boss job (singleton per subscription, payload = opaque shop
id + subscription id, **never an email**); `subscribe()` no longer returns the raw
confirm token. The worker (`send.server.ts`) loads the row, mints a **fresh** confirm
token (stores only its hash + 7-day expiry; the raw token lives only in the email),
sends with the retry/permanent-transient handling, is **exactly-once** via
`confirm_sent_at` (a replay sends nothing), and never mails an already-confirmed /
suppressed / expired row. A **deterministic response-time floor** (`RESPONSE_FLOOR_MS`
= 150 ms, a plain timer — no randomness) pads every outcome of the subscribe route,
and the confirm + unsubscribe routes, so the sub-millisecond "enqueued vs exists"
difference is masked. **Residual:** the floor never shortens a response and does not
hide gross DB contention; it masks the cheap-outcome difference.

**Before/after (request path):** inline send — new ≈ 319 ms, existing ≈ 3 ms (Δ ≈
316 ms). Async + floor — new ≈ 150 ms, existing ≈ 150 ms (Δ < 60 ms in the test,
typically a few ms). **Tests (`phase12-async`):** new/existing/… outcomes all land
at ~the floor and differ by < 60 ms; the created outcome enqueues exactly one job,
"exists" enqueues none; the worker job delivers exactly one and a replay sends
nothing; a transient failure leaves `confirm_sent_at` null (retryable); a slow
(250 ms) provider delays only the job, not the request path. **Mutation:**
reintroducing an inline send in the request path made new−existing ≈ 260 ms — the
equalisation test failed; restored → pass.

### Q3 (MEDIUM — email-hash key rotation)

**Failing input:** the email-lookup HMAC fell back to `SHOPIFY_API_SECRET`; rotating
that secret would orphan every stored `email_hash` (dedupe fails, suppression stops
working, `customers/redact` can't find rows).

**New behaviour:** a **per-shop random pepper** (32 bytes, `restock_hash_pepper`, a
tenant table with RLS ENABLED+FORCED, `app_runtime` grants) keys that shop's email
hashes. It is generated lazily on first use under RLS with a **race-safe**
`INSERT … ON CONFLICT DO NOTHING` + `SELECT` (two concurrent first-use requests
converge on one pepper), never returned/logged/exported, and **erased on
`shop/redact` + uninstall**. The `SHOPIFY_API_SECRET` fallback is removed from email
hashing (confirm/unsubscribe tokens still use the app secret, independent of the
pepper). All lookups (subscribe dedupe, suppression, send-time, `data_request`,
`redact`, admin search, delete-all) obtain the pepper in-tenant. **Tests
(`phase12-privacy` Q3):** rotating `SHOPIFY_API_SECRET` leaves hashes unchanged
(dedupe still sees "exists"); two shops' hashes differ; concurrent first-use → one
pepper; pepper erased on redact; RLS cross-shop on the new table.

### Q4 (LOW)

(a) The AES-256-GCM ciphertext is now **bound to its context** with Associated Data
(`<shopId>:email_setting.password`) and a **version byte** (clean v1 format; no
legacy ciphertext exists). Decrypting a ciphertext copied into another shop's row
fails (`phase12-units`, `phase12-privacy`). (b) The admin send-test cooldown moved
from an in-memory per-process `Map` to the database (`email_setting.last_test_email_at`,
stamped atomically by `claimSendTest`), so it holds across instances/restarts.

### Gates

`typecheck`, `build`, `worker:build`, locale-parity clean. Full suite **630 passed |
13 skipped** (up from the Phase 12 baseline **587 | 13**; +43 tests across two new
files — `phase12-ssrf` (32), `phase12-async` (6) — plus reworked units/engine/
privacy; 13 skips unchanged; **none weakened**). Existing tests that relied on the
inline send or a loopback SMTP host were updated to the async-job / injected-
resolver path (noted explicitly): `phase12-smtp` now injects a resolver returning a
public IP and uses TLS for the AUTH paths; the subscribe→confirm lifecycle, restock
`beforeEach`, and GDPR tests obtain the confirm token from the worker-sent email.

## Phase 12.2 — CI-parity fix batch (over Phase 12.1)

The Live-Prisma Check failed on the Phase 12 line (runs #18/#19): `Tests 5 failed`,
all `EncryptionKeyMissingError: EMAIL_ENCRYPTION_KEY is not configured`
(`phase12-units` ×4, `phase12-privacy` ×1). Migrations 0013–0016 and the 13
prisma-integration tests passed live.

**Root cause:** the tests were not hermetic. The build sandbox has a gitignored
`.env` defining `EMAIL_ENCRYPTION_KEY`, so the AES tests passed locally; CI has no
`.env`, the workflow's `env:` block did not provide the key, and the key-absent
save/restore used `process.env.X = saved` (which assigns the string `"undefined"`
when `saved` is undefined). Reproduced here by scrubbing `.env` and the environment.

**Fix (R1–R4), no schema change required except an additive migration already in
0016 — none added here):**

- **R1 hermetic tests.** `test/setup.ts` sets a fixed TEST-ONLY `EMAIL_ENCRYPTION_KEY`
  (64-hex throwaway) when `NODE_ENV=test` and it is unset, so the suite never
  depends on a developer's `.env`. The buggy `process.env.X = saved` restores were
  replaced with a `restoreEnv(key, saved)` helper (`delete` when `saved` is
  `undefined`); all occurrences fixed. The key-absent test still proves the save is
  refused — it now uses a VALID destination so it fails for the right reason
  (missing key), asserting `EncryptionKeyMissingError`.
- **R2 workflow parity.** `live-prisma-check.yml` adds `EMAIL_ENCRYPTION_KEY` as a
  clearly-labelled CI-only throwaway, so the real worker step has it too. The
  prisma-integration skip hard-fail and every other check are unchanged.
- **R3 `npm run test:ci-parity`.** Runs the full suite the way CI does: `.env`
  ignored (`CI_PARITY=1` makes `test/setup.ts` skip dotenv), in a scrubbed env
  built from the workflow's `env:` block (parsed from the yml, so the two cannot
  drift; the four `*DATABASE_URL`s are mapped to the local instance since DB
  location is infra, and every app secret — notably `EMAIL_ENCRYPTION_KEY` — comes
  only from the workflow block). A drift-guard test (`ci-parity-guard`) fails if the
  workflow stops providing a required var. **Demonstrated:** with R1 reverted and no
  key in the env, `test:ci-parity` reproduced exactly the 5 `EncryptionKeyMissingError`
  failures (`phase12-units` ×4, `phase12-privacy` ×1); with R1 applied it passes.
- **R4 archive hygiene.** The deliverable archive is now packaged from **tracked
  files only** (a fresh `git clone` of the repo, then tar) — it includes `.git` but
  no `node_modules`, no build output, and **no `.env`** (the previous archive
  leaked a local `.env`). `.env.example` documents `EMAIL_ENCRYPTION_KEY`; there is
  no stale `RESTOCK_HASH_KEY` anywhere (removed with the env fallback in 12.1).

**Carry-overs (R5):**

- **R5a save-time destination feedback.** `validateDestination` now rejects, by pure
  syntax (no DNS), any IP literal for which `isPublicIp()` is false (127.0.0.1, ::1,
  10.x, 169.254.169.254, …) and the hostnames `localhost` / `*.localhost` / `*.local`
  / `*.internal` / `*.localdomain` — so the merchant gets an early error, not just at
  connect time. Tests cover each.
- **R5b lost-confirmation sweeper.** A pending row whose confirmation never got sent
  (enqueue failed or the process died after commit) was stranded forever
  (re-subscribing returns "exists"). A sweeper on the existing maintenance tick
  (`runRestockConfirmSweep` → `selectStrandedConfirmations`) re-enqueues the confirm
  job (same singleton key ⇒ no duplicates) for `pending`, `confirm_sent_at IS NULL`
  rows older than 5 minutes, younger than the 7-day TTL, not suppressed — RLS-scoped,
  bounded batches, idempotent. The public handler now **fire-and-forgets** the
  enqueue so it can never extend the response past the 150 ms floor (a slow/failed
  enqueue is recovered by the sweeper). Tests: selects only genuinely-stranded rows
  (not sent/confirmed/expired/suppressed/too-fresh); bounded; cross-shop isolated;
  stops once sent; a 400 ms enqueue no longer changes new-vs-exists response time.
  **Mutation:** dropping the `confirm_sent_at IS NULL` guard made the sweeper pick a
  sent row → the test failed; restored → pass.

### Gates

`typecheck`, `build`, `worker:build`, locale-parity clean. Both the normal full
suite (`npm test`) and `npm run test:ci-parity` report **647 passed | 13 skipped**
(up from the Phase 12.1 baseline **630 | 13**; +17 tests — `ci-parity-guard` (11),
`phase12-sweeper` (5), plus the R5a/R5b additions; 13 skips unchanged; **none
weakened**). From now on `test:ci-parity` is run and reported before a phase is
declared done.

## Next step

Awaiting the re-run of the Live-Prisma GitHub Actions workflow. Phase 13 is **not**
started (no approval).

## STATUS

PHASE 12.2 IMPLEMENTED & PG-VERIFIED (npm test AND npm run test:ci-parity both 647
passed | 13 skipped; Phase 12.1 baseline 630 | 13, none weakened). LIVE-PRISMA
CONFIRMATION PENDING. PHASE 13 NOT STARTED.
