# Phase 12 — Back-in-stock, pre-order messaging, countdowns, email delivery

Phase 12 adds four shopper-facing features on top of the existing catalog/index,
worker and theme extension — **with no new Shopify scope, no new npm dependency,
no new PostgreSQL extension, and no Shopify Function**. Everything is PostgreSQL-
only and deterministic. Migration `0015_phase12_restock` is additive + idempotent.

Scopes are unchanged (`read_products`). This phase stores **shopper email
addresses** (back-in-stock), so it ships the mandatory privacy/retention/GDPR
machinery described in §7.

## 12.1 Email delivery — provider-agnostic, Node built-ins only

`EmailProvider` (`app/lib/email/provider.ts`) is the existing interface. Phase 12
adds `SmtpEmailProvider` (`app/lib/email/smtp.ts`) implemented with **only
`node:net` / `node:tls`** — no nodemailer/SendGrid/Resend SDK. It speaks enough
SMTP to deliver one message: EHLO → (STARTTLS | implicit TLS) → AUTH PLAIN/LOGIN
→ MAIL FROM → RCPT TO → DATA (dot-stuffed) → QUIT, with:

- hard per-step + overall **timeouts**, a **256 KB message size cap**;
- strict **header-injection protection** (`app/lib/email/mime.ts`): any CR/LF/NUL
  in a header value is rejected; the Subject is **RFC 2047**-encoded when
  non-ASCII; From/To/Reply-To are validated **bare** addresses (a display-name
  form like `Victim <a@b>` is rejected, closing the `To:…\r\nBcc:` vector);
  extra headers are allowlisted (`List-Unsubscribe`, `List-Unsubscribe-Post`,
  `Auto-Submitted`);
- **multipart/alternative** text+html with a one-click **List-Unsubscribe** pair
  (RFC 8058);
- **bounded retries with backoff**; typed errors distinguishing **permanent**
  (5xx / malformed input → never retried, marks bounced) from **transient**
  (4xx / network / timeout → retried, left pending).

The socket factory is injectable, so the protocol is tested against a **local,
in-process fake SMTP server** (no network): AUTH PLAIN/LOGIN, 4xx transient, 5xx
permanent, timeout, header-injection, dot-stuffing, oversized body, non-ASCII
subject (`test/phase12-smtp.test.ts`).

**Credentials at rest.** Per-shop SMTP settings (`email_setting`) store the
password **encrypted with AES-256-GCM** (`app/lib/crypto/secret.server.ts`),
key from `EMAIL_ENCRYPTION_KEY` (32 bytes, hex or base64). The app **refuses to
save a password when the key is absent** (nothing is written). The password is
**write-only**: never returned to a client and never logged — the admin sees only
`configured` + at most the **last 2 characters**. `NoopEmailProvider` remains the
default ("email not configured": subscriptions are still collected, nothing is
sent — clearly shown in admin). A rate-limited **send-test** action mails only the
shop's own configured From address.

## 12.2 Back-in-stock subscriptions — double opt-in

`back_in_stock_subscription` stores, per (shop, email, product, variant): the
**normalised** email (lowercased/trimmed, Unicode-canonicalised the same way as
the analytics PII layer) plus a **keyed HMAC-SHA256 `email_hash`** used for all
lookups/dedupe/suppression/redaction, the locale, a consent record
(`consented_at`, `consent_text_version`, `source`), a status
(`pending|confirmed|notified|unsubscribed|bounced`), and **hashed** confirm +
unsubscribe tokens.

- **Double opt-in:** a new row is `pending` with a signed, 7-day-expiring confirm
  link; a confirmation email is sent **before any alert is ever possible**.
  Unconfirmed rows are never mailed an alert and are purged after 7 days.
- **Only visible + unavailable products.** `checkSubscribable` requires the
  product to be a **published, ACTIVE doc in the active index version** AND
  currently **unavailable** (product-level `available=false`, or the chosen
  variant `available_for_sale=false`); otherwise nothing is stored.
- **Dedupe** on a unique `(shop, email_hash, product, variant_key)` index
  (`variant_key=''` means product-level). A duplicate returns the **same generic
  response** and creates no row / no resend.
- **Caps** (anti-spam / anti-flood, per shop, configurable): `per_email_daily_cap`
  (default 10), `per_shop_daily_cap` (default 5000).
- **Suppression** is honoured at subscribe time (and send time): an unsubscribed /
  bounced / retention-reduced address is never re-collected or re-mailed.
- The **public response never reveals** whether an email is already subscribed —
  every outcome (`created | exists | rejected | suppressed | capped |
  not_applicable`) maps to one identical `{ ok:true, status:"received" }`.

Public endpoint `proxy/back-in-stock` (signed by `handleProxy`, per-shop rate
limited, never 5xx): strict email/gid/variant/locale validation **before any
SQL**, a 4 KB body cap, generic response. Theme block **`boost-notify.liquid`**
("Notify me when available", product template): email field, an **explicit
consent checkbox that is unchecked by default and never pre-ticked** (text from
locales), `aria-live` status, reserved space; the form renders **only when the
selected variant is unavailable** and is a silent no-op otherwise or on failure;
`textContent`-only (`boost-notify.js`, never `innerHTML`).

## 12.3 Restock detection + notification

Availability transitions are detected from the catalog the app **already syncs**
(`read_products`: product/variant upserts + reconciliation; no inventory scope),
inside the same RLS transaction as the doc refresh (`applyProductUpsert` →
`detectAndQueueRestock`). A shop with no subscribers pays **one existence SELECT**
and writes nothing (byte-identical).

- `restock_availability` holds a per-target **monotonic availability EPOCH** and
  `last_source_at` (the product's `shopify_updated_at`). A stale / out-of-order
  signal (`source_at <= last_source_at`) is **ignored** (Phase 2.1 rule), so a
  late "went unavailable" cannot cause a spurious re-notification.
- On an unavailable→available flip of a target with **confirmed** subscribers, the
  epoch bumps and `createPendingNotifications` inserts **one pending row per
  subscriber in a single set-based statement** (the fan-out does **not** grow a
  query per subscriber — measured: 1 query for 21 subscribers). The ledger
  (`restock_notification`) is unique on `(shop, subscription, epoch)`, so a replay
  / re-detection of the same epoch inserts nothing (idempotent).
- The worker drains per shop as a **singleton** (`restock-drain`, singletonKey =
  shopId; `enqueueRestockDrain` carries **shopId only** — never an email), a
  bounded batch (`send_rate_per_run`, default 100). At **send time** it re-checks
  subscription status, suppression, and **availability + visibility** — it never
  mails "back in stock" for a product that is again sold out / unpublished. One
  email per subscription (the row flips to `notified`). A permanent provider error
  marks `bounced` and suppresses the address; a transient error leaves the row
  pending for a later run. Every email carries the shop identity, a visible-doc
  product title/URL (URLs through the same https/own-domain allowlist), and a
  one-click unsubscribe link. Content is generic and localisable (en + fr).

Public unsubscribe `restock/unsubscribe` (GET link + RFC 8058 one-click POST) and
confirm `restock/confirm`: no login; the shop id (`sid`) binds RLS **directly**
(no domain→id lookup, so a forged link never creates a shop row); the token is
verified in constant time; **idempotent**; a generic HTML page that never reveals
whether the subscription exists; never 5xx.

## 12.4 Pre-order messaging — DISPLAY ONLY

Merchant rules (`preorder_rule`) match a product by **tag / handle / gid /
collection**, with an optional release date and message and an optional schedule
window (start-inclusive, end-exclusive). A matching, enabled, in-window rule makes
the storefront show a **"Pre-order / ships on <date>" badge + note**:

- on **search / recommendation / bundle cards** via the **existing card payload**
  — `attachPreorder` adds a `preorder` field **only when a rule matches**; with no
  enabled rules every existing payload is **byte-identical** (the annotate step
  returns an empty map and attaches nothing);
- on the **product block** via `proxy/preorder?product=<gid|handle>` +
  `boost-preorder.liquid` / `boost-preorder.js` (`textContent` only).

Dates are stored **UTC**; the theme formats for display. The **most specific**
rule wins deterministically (gid > handle > collection > tag).

> **This app does NOT make an out-of-stock product purchasable.** Whether a
> pre-order product can actually be bought — `continue selling when out of stock`,
> selling plans, deferred/partial payment, checkout changes — is configured by the
> **merchant in Shopify** and needs unapproved scopes / a Shopify Function =
> **Requires Verification**. Phase 12 only renders messaging.

## 12.5 Countdown timers — display only

`countdown_rule` targets a **product / collection / global** scope and counts down
to a **UTC end timestamp**, with an optional start (hidden before it opens) and an
optional expired message. `proxy/countdown?product=<ref>` returns the applicable
countdown **plus a server `now`** so the client corrects for **clock skew**. The
block **`boost-countdown.liquid` / `boost-countdown.js`** renders via
`textContent` only, on a **bounded interval**, respects **prefers-reduced-motion**
(slower tick), announces only **coarse** changes to assistive tech (about once a
minute — the ticking clock is `aria-hidden`), shows **nothing** before the window
opens and, after expiry, the merchant's expired message or nothing, and is a
silent no-op on failure. **No price or checkout effect.**

## 12.6 Admin — `/app/restock`

Registered in `app/routes.ts`. Email (SMTP) settings with a **write-only**
password + status + rate-limited send-test; subscriptions (counts by status,
exact-email search by **hash** with **masked** display `j***@e***.com`, per-row
delete, delete-all-for-email); notification stats; pre-order + countdown rule
CRUD; retention & caps. CSV export (`/app/restock/export`) reuses the existing
**formula-injection protection** + hard row cap and shows **masked** emails.

## 12.7 Privacy, compliance, retention (mandatory)

- **Lawful basis:** the shopper's explicit, double-opt-in consent, recorded per
  subscription (`consented_at`, `consent_text_version`, `source`).
- **Data held:** the shopper's email (normalised plaintext, needed to send) + a
  keyed `email_hash`, the product/variant they subscribed to, locale, status,
  timestamps, and hashed tokens — **only** on `back_in_stock_subscription`. The
  notification ledger, jobs, logs and analytics **never** hold the address: jobs
  carry shopId / subscription ids only; logs show **masked** emails; the ledger
  has no email column (asserted by a test). Merchant SMTP settings hold the shop's
  own From/Reply-To and the encrypted password.
- **`customers/data_request`:** looks the email up by hash and records exactly how
  many subscriptions are held — it does **not** report `no_data` when rows exist.
- **`customers/redact`:** deletes **every** subscription for that email hash in the
  shop (the notification ledger cascades) plus any suppression record,
  **idempotently**, and records the result.
- **`shop/redact` + uninstall:** deletes all rows of all eight new tables for the
  shop (explicit in-tenant erase; FK cascade also covers them on an owner shop-row
  delete).
- **Retention** (in the existing maintenance tick, per shop, **bounded batches**,
  RLS): unconfirmed rows purged after **7 days**; `notified|unsubscribed|bounced`
  rows older than the configured window (default **30 days**, **≤ 90**) are reduced
  to a **minimal hashed-email suppression record** then deleted, so an unsubscribed
  address is never re-mailed; old notification-ledger rows are cleaned up.
- The **suppression list** is honoured at subscribe time and send time.

## Rules, caps and windows (defaults)

| Setting | Default | Bound |
|---|---|---|
| `per_email_daily_cap` | 10 | 1–1000 |
| `per_shop_daily_cap` | 5000 | 1–1,000,000 |
| `send_rate_per_run` | 100 | 1–10,000 |
| `notified_retention_days` | 30 | 1–90 |
| unconfirmed TTL | 7 days | fixed |
| confirm link TTL | 7 days | fixed |

## What is and is NOT implemented

- **Implemented (fully, first-party):** SMTP email via Node built-ins + encrypted
  per-shop creds; back-in-stock capture with double opt-in, dedupe, caps,
  suppression; restock detection + idempotent notification from `read_products`
  data with a send-time re-check; pre-order **messaging** on cards + product block;
  **display-only** countdown; admin; GDPR + retention.
- **NOT implemented / Requires Verification:** making an out-of-stock product
  **purchasable** (selling plans / continue-selling / checkout — merchant Shopify
  config, unapproved scopes / a Shopify Function); real email **deliverability**
  (SPF/DKIM/DMARC, reverse DNS, port 25/465/587 egress and provider behaviour are
  the merchant's responsibility); live **App Proxy** signature + beacon and live
  **theme rendering** of the blocks on a real storefront; precise shop-timezone
  date formatting in the theme (the server stores UTC; the block formats locally).

## Email deliverability notes

The app sends through the **merchant's own SMTP server** with their credentials.
Deliverability — SPF, DKIM, DMARC alignment, the sending domain's reputation, PTR
records, and whether the host network permits outbound SMTP on 25/465/587 — is
entirely the merchant's responsibility and cannot be verified from this codebase.
The one-click `List-Unsubscribe` header is included to aid inbox placement.

## Performance

No performance numbers are claimed (Phase 14). Hot-path **query counts** are
reported in `docs/PHASE12_REPORT.md` and asserted by tests (subscribe; the
restock fan-out, which does not grow per subscriber; the product-page lookups).
