-- Migration 0015 — Phase 12: Back-in-stock, pre-order messaging, countdowns,
-- email delivery. Applied by app_owner. Additive + idempotent (CREATE TABLE IF
-- NOT EXISTS / ADD COLUMN IF NOT EXISTS / re-assertable RLS + grants). No new
-- Shopify scope, no new extension, no new npm dependency, no new PG extension.
--
-- PRIVACY: these tables store shopper EMAIL ADDRESSES (lawful basis: the
-- shopper's explicit opt-in consent, double-opt-in confirmed). Every table is a
-- tenant table: shop_id FK, RLS ENABLED + FORCED, tenant policy on
-- app_current_shop(), DML granted to app_runtime only. Emails are stored
-- normalised (lowercase, trimmed) ALONGSIDE a keyed hash (email_hash) used for
-- all lookups / dedupe / suppression / redaction, so the plaintext is only ever
-- touched to actually send a message. NO email text is ever copied into
-- analytics, logs, job payloads or error columns (see app code).
--
-- No SECURITY DEFINER function is added by this phase: restock detection and
-- all reads/writes run as app_runtime under RLS (the catalog tables this phase
-- reads — product / variant / product_search_doc — are already tenant tables).

-- ===========================================================================
-- 12.1 Per-shop email (SMTP) settings. Password is stored ENCRYPTED at rest
-- (AES-256-GCM; key from env EMAIL_ENCRYPTION_KEY). The app refuses to save a
-- password when the key is absent, and never logs or returns the ciphertext.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "email_setting" (
  "shop_id"          UUID PRIMARY KEY REFERENCES "shop"("id") ON DELETE CASCADE,
  "host"             TEXT,
  "port"             INT CHECK ("port" IS NULL OR ("port" >= 1 AND "port" <= 65535)),
  "security"         TEXT NOT NULL DEFAULT 'starttls' CHECK ("security" IN ('none','starttls','tls')),
  "username"         TEXT,
  "password_cipher"  TEXT,                 -- base64(iv(12) || tag(16) || ciphertext); never returned
  "from_email"       TEXT,
  "from_name"        TEXT,
  "reply_to"         TEXT,
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 12.6 Per-shop restock/notification settings (caps + retention windows).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "restock_setting" (
  "shop_id"                 UUID PRIMARY KEY REFERENCES "shop"("id") ON DELETE CASCADE,
  "per_email_daily_cap"     INT NOT NULL DEFAULT 10  CHECK ("per_email_daily_cap"  >= 1 AND "per_email_daily_cap"  <= 1000),
  "per_shop_daily_cap"      INT NOT NULL DEFAULT 5000 CHECK ("per_shop_daily_cap"  >= 1 AND "per_shop_daily_cap"  <= 1000000),
  "send_rate_per_run"       INT NOT NULL DEFAULT 100  CHECK ("send_rate_per_run"   >= 1 AND "send_rate_per_run"   <= 10000),
  "notified_retention_days" INT NOT NULL DEFAULT 30   CHECK ("notified_retention_days" >= 1 AND "notified_retention_days" <= 90),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 12.2 Back-in-stock subscriptions. Double opt-in. email stored normalised +
-- keyed hash for lookups. Tokens stored HASHED only. variant_key = '' means a
-- product-level subscription; otherwise it is the shopify variant gid.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "back_in_stock_subscription" (
  "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"              UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "product_id"           UUID NOT NULL REFERENCES "product"("id") ON DELETE CASCADE,
  "shopify_product_gid"  TEXT NOT NULL,
  "variant_id"           UUID REFERENCES "variant"("id") ON DELETE CASCADE,
  "variant_gid"          TEXT,
  "variant_key"          TEXT NOT NULL DEFAULT '',   -- '' = product-level; else variant gid
  "email"                TEXT NOT NULL,              -- normalised lowercase (needed to send)
  "email_hash"           TEXT NOT NULL,              -- keyed HMAC-SHA256 hex (lookups/dedupe/redact)
  "locale"               TEXT NOT NULL DEFAULT 'en' CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  "status"               TEXT NOT NULL DEFAULT 'pending'
                           CHECK ("status" IN ('pending','confirmed','notified','unsubscribed','bounced')),
  "consented_at"         TIMESTAMPTZ,
  "consent_text_version" TEXT,
  "source"               TEXT CHECK ("source" IS NULL OR "source" IN ('product_page','search','predictive','recommendation','bundle','other')),
  "confirm_token_hash"   TEXT,                       -- hashed random token
  "confirm_expires_at"   TIMESTAMPTZ,
  "unsubscribe_token_hash" TEXT NOT NULL,            -- hashed random token
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "confirmed_at"         TIMESTAMPTZ,
  "notified_at"          TIMESTAMPTZ,
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Dedupe: one row per (shop, email, product, variant). variant_key makes the
-- nullable variant part of a usable unique key.
CREATE UNIQUE INDEX IF NOT EXISTS "bis_dedupe_key"
  ON "back_in_stock_subscription" ("shop_id","email_hash","shopify_product_gid","variant_key");
CREATE INDEX IF NOT EXISTS "bis_shop_status_idx" ON "back_in_stock_subscription" ("shop_id","status");
CREATE INDEX IF NOT EXISTS "bis_product_idx" ON "back_in_stock_subscription" ("shop_id","product_id","status");
CREATE INDEX IF NOT EXISTS "bis_emailhash_idx" ON "back_in_stock_subscription" ("shop_id","email_hash");
CREATE INDEX IF NOT EXISTS "bis_created_idx" ON "back_in_stock_subscription" ("shop_id","created_at");
CREATE INDEX IF NOT EXISTS "bis_confirm_expiry_idx" ON "back_in_stock_subscription" ("shop_id","status","confirm_expires_at");

-- ===========================================================================
-- 12.3 Availability-transition state (for unavailable->available detection +
-- a per-target monotonic availability EPOCH used as the notification
-- idempotency key). variant_key '' = product level. last_source_at is the
-- product's shopify_updated_at at the time we recorded, enforcing the Phase 2.1
-- monotonic rule (an out-of-order/older signal is ignored).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "restock_availability" (
  "shop_id"        UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "product_id"     UUID NOT NULL REFERENCES "product"("id") ON DELETE CASCADE,
  "variant_key"    TEXT NOT NULL DEFAULT '',
  "available"      BOOLEAN NOT NULL DEFAULT false,
  "epoch"          INT NOT NULL DEFAULT 0,       -- bumped on each unavailable->available flip
  "last_source_at" TIMESTAMPTZ,                  -- monotonic guard (product.shopify_updated_at)
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("shop_id","product_id","variant_key")
);

-- ===========================================================================
-- 12.3 Notification ledger. One row per (subscription, availability epoch) is
-- the idempotent unit: INSERT ... ON CONFLICT DO NOTHING means a webhook replay
-- or re-detection of the same availability epoch creates no second send. error
-- is operational only (masked; never the email address).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "restock_notification" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"         UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "subscription_id" UUID NOT NULL REFERENCES "back_in_stock_subscription"("id") ON DELETE CASCADE,
  "epoch"           INT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'pending'
                      CHECK ("status" IN ('pending','sent','bounced','skipped')),
  "error"           TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "sent_at"         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "restock_notification_idem"
  ON "restock_notification" ("shop_id","subscription_id","epoch");
CREATE INDEX IF NOT EXISTS "restock_notification_pending_idx"
  ON "restock_notification" ("shop_id","status","created_at");

-- ===========================================================================
-- 12.7 Suppression list. After unsubscribe/notify + retention, a subscription
-- is reduced to a minimal hashed-email suppression record so the address is
-- never re-mailed. Honoured at subscribe time and at send time. No plaintext.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "restock_suppression" (
  "shop_id"    UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "email_hash" TEXT NOT NULL,
  "reason"     TEXT NOT NULL DEFAULT 'unsubscribed' CHECK ("reason" IN ('unsubscribed','bounced','retention')),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("shop_id","email_hash")
);

-- ===========================================================================
-- 12.4 Pre-order messaging rules (DISPLAY ONLY — no checkout change).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "preorder_rule" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"     UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "match_type"  TEXT NOT NULL CHECK ("match_type" IN ('tag','handle','gid','collection')),
  "match_value" TEXT NOT NULL CHECK (length("match_value") >= 1 AND length("match_value") <= 500),
  "message"     TEXT CHECK ("message" IS NULL OR length("message") <= 300),
  "release_at"  TIMESTAMPTZ,
  "starts_at"   TIMESTAMPTZ,
  "ends_at"     TIMESTAMPTZ,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "preorder_rule_shop_idx" ON "preorder_rule" ("shop_id","enabled");

-- ===========================================================================
-- 12.5 Countdown rules (display only — no price/checkout change).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "countdown_rule" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id"         UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
  "scope"           TEXT NOT NULL CHECK ("scope" IN ('product','collection','global')),
  "match_value"     TEXT CHECK ("match_value" IS NULL OR (length("match_value") >= 1 AND length("match_value") <= 500)),
  "label"           TEXT CHECK ("label" IS NULL OR length("label") <= 120),
  "ends_at"         TIMESTAMPTZ NOT NULL,
  "starts_at"       TIMESTAMPTZ,
  "expired_message" TEXT CHECK ("expired_message" IS NULL OR length("expired_message") <= 200),
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "countdown_rule_shop_idx" ON "countdown_rule" ("shop_id","enabled");

-- ===========================================================================
-- Grants (app_runtime only) + RLS ENABLED + FORCED + tenant policy on every
-- new table. Re-assertable/idempotent.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_setting"                TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "restock_setting"              TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "back_in_stock_subscription"   TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "restock_availability"         TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "restock_notification"         TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "restock_suppression"          TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "preorder_rule"                TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "countdown_rule"               TO app_runtime;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'email_setting','restock_setting','back_in_stock_subscription',
    'restock_availability','restock_notification','restock_suppression',
    'preorder_rule','countdown_rule'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (shop_id = app_current_shop()) WITH CHECK (shop_id = app_current_shop());',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
