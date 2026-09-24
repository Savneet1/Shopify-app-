-- Migration 0001_init — schema v1 tables (Phase 1 foundation).
-- Applied by `prisma migrate deploy` (runs as DIRECT_DATABASE_URL = app_owner),
-- so all tables are owned by app_owner. Column names match prisma/schema.prisma
-- (@map for snake_case tenant columns; Shopify Session keeps camelCase columns).

-- gen_random_uuid() is in PostgreSQL core since v13.

-- ---------------------------------------------------------------------------
-- Shopify-managed session table (auth infrastructure; not RLS-scoped).
-- ---------------------------------------------------------------------------
CREATE TABLE "session" (
    "id"            TEXT PRIMARY KEY,
    "shop"          TEXT NOT NULL,
    "state"         TEXT NOT NULL,
    "isOnline"      BOOLEAN NOT NULL DEFAULT false,
    "scope"         TEXT,
    "expires"       TIMESTAMP(3),
    "accessToken"   TEXT NOT NULL,
    "userId"        BIGINT,
    "firstName"     TEXT,
    "lastName"      TEXT,
    "email"         TEXT,
    "accountOwner"  BOOLEAN NOT NULL DEFAULT false,
    "locale"        TEXT,
    "collaborator"  BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);

-- ---------------------------------------------------------------------------
-- Tenant root.
-- ---------------------------------------------------------------------------
CREATE TABLE "shop" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_domain"      TEXT NOT NULL,
    "shopify_shop_gid" TEXT,
    "name"             TEXT,
    "email"            TEXT,
    "plan_name"        TEXT,
    "access_scopes"    TEXT,
    "installed_at"     TIMESTAMP(3),
    "uninstalled_at"   TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "shop_shop_domain_key" ON "shop" ("shop_domain");

-- ---------------------------------------------------------------------------
-- Per-shop settings.
-- ---------------------------------------------------------------------------
CREATE TABLE "app_setting" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"    UUID NOT NULL,
    "key"        TEXT NOT NULL,
    "value"      JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
    CONSTRAINT "app_setting_shop_id_fkey" FOREIGN KEY ("shop_id")
        REFERENCES "shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "app_setting_shop_id_key_key" ON "app_setting" ("shop_id", "key");
CREATE INDEX "app_setting_shop_id_idx" ON "app_setting" ("shop_id");

-- ---------------------------------------------------------------------------
-- Markets.
-- ---------------------------------------------------------------------------
CREATE TABLE "market" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"            UUID NOT NULL,
    "shopify_market_gid" TEXT,
    "name"               TEXT NOT NULL,
    "currency_code"      TEXT NOT NULL,
    "is_primary"         BOOLEAN NOT NULL DEFAULT false,
    "enabled"            BOOLEAN NOT NULL DEFAULT true,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT now(),
    CONSTRAINT "market_shop_id_fkey" FOREIGN KEY ("shop_id")
        REFERENCES "shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "market_shop_id_idx" ON "market" ("shop_id");

-- ---------------------------------------------------------------------------
-- Webhook receipts (idempotency).
-- ---------------------------------------------------------------------------
CREATE TABLE "webhook_receipt" (
    "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"      UUID NOT NULL,
    "webhook_id"   TEXT NOT NULL,
    "topic"        TEXT NOT NULL,
    "api_version"  TEXT,
    "payload_hash" TEXT NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'received',
    "received_at"  TIMESTAMP(3) NOT NULL DEFAULT now(),
    "processed_at" TIMESTAMP(3),
    "error"        TEXT,
    CONSTRAINT "webhook_receipt_shop_id_fkey" FOREIGN KEY ("shop_id")
        REFERENCES "shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "webhook_receipt_shop_id_webhook_id_key" ON "webhook_receipt" ("shop_id", "webhook_id");
CREATE INDEX "webhook_receipt_webhook_id_idx" ON "webhook_receipt" ("webhook_id");

-- ---------------------------------------------------------------------------
-- Theme compatibility reports.
-- ---------------------------------------------------------------------------
CREATE TABLE "theme_compat_report" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"    UUID NOT NULL,
    "theme_gid"  TEXT,
    "theme_name" TEXT,
    "role"       TEXT,
    "os2"        BOOLEAN,
    "status"     TEXT NOT NULL DEFAULT 'unknown',
    "details"    JSONB,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
    CONSTRAINT "theme_compat_report_shop_id_fkey" FOREIGN KEY ("shop_id")
        REFERENCES "shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "theme_compat_report_shop_id_idx" ON "theme_compat_report" ("shop_id");

-- ---------------------------------------------------------------------------
-- Privacy / deletion requests.
-- ---------------------------------------------------------------------------
CREATE TABLE "data_deletion_request" (
    "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"             UUID NOT NULL,
    "topic"               TEXT NOT NULL,
    "shopify_customer_id" TEXT,
    "customer_email"      TEXT,
    "payload"             JSONB NOT NULL,
    "status"              TEXT NOT NULL DEFAULT 'pending',
    "requested_at"        TIMESTAMP(3) NOT NULL DEFAULT now(),
    "processed_at"        TIMESTAMP(3),
    CONSTRAINT "data_deletion_request_shop_id_fkey" FOREIGN KEY ("shop_id")
        REFERENCES "shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "data_deletion_request_shop_id_idx" ON "data_deletion_request" ("shop_id");

-- ---------------------------------------------------------------------------
-- Billing subscription (abstraction persistence).
-- ---------------------------------------------------------------------------
CREATE TABLE "billing_subscription" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"            UUID NOT NULL,
    "provider"           TEXT NOT NULL DEFAULT 'stub',
    "plan"               TEXT NOT NULL DEFAULT 'free',
    "status"             TEXT NOT NULL DEFAULT 'inactive',
    "external_id"        TEXT,
    "test"               BOOLEAN NOT NULL DEFAULT true,
    "current_period_end" TIMESTAMP(3),
    "activated_at"       TIMESTAMP(3),
    "canceled_at"        TIMESTAMP(3),
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT now(),
    CONSTRAINT "billing_subscription_shop_id_fkey" FOREIGN KEY ("shop_id")
        REFERENCES "shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "billing_subscription_shop_id_idx" ON "billing_subscription" ("shop_id");
