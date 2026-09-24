-- Migration 0003 — Phase 2: catalog + versioned index + sync/job tables.
-- Runs as app_owner. Every tenant table carries shop_id + RLS (+FORCE) keyed on
-- app_current_shop(); app_runtime gets DML grants. Mirrors the Phase 1 pattern.

-- ===========================================================================
-- Catalog
-- ===========================================================================
CREATE TABLE "product" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"            UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "shopify_product_gid" TEXT NOT NULL,
    "handle"             TEXT,
    "title"              TEXT,
    "description"        TEXT,
    "vendor"             TEXT,
    "product_type"       TEXT,
    "status"             TEXT,
    "tags"               JSONB NOT NULL DEFAULT '[]',
    "options"            JSONB NOT NULL DEFAULT '[]',
    "shopify_updated_at" TIMESTAMP(3),
    "deleted_at"         TIMESTAMP(3),
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "product_shop_gid_key" ON "product"("shop_id","shopify_product_gid");
CREATE INDEX "product_shop_idx" ON "product"("shop_id");

CREATE TABLE "variant" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"            UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "product_id"         UUID NOT NULL REFERENCES "product"("id") ON DELETE CASCADE,
    "shopify_variant_gid" TEXT NOT NULL,
    "sku"                TEXT,
    "barcode"            TEXT,
    "title"              TEXT,
    "price"              NUMERIC(12,2),
    "position"           INTEGER,
    "selected_options"   JSONB NOT NULL DEFAULT '[]',
    "shopify_updated_at" TIMESTAMP(3),
    "deleted_at"         TIMESTAMP(3),
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "variant_shop_gid_key" ON "variant"("shop_id","shopify_variant_gid");
CREATE INDEX "variant_product_idx" ON "variant"("product_id");
CREATE INDEX "variant_shop_idx" ON "variant"("shop_id");

CREATE TABLE "collection" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"            UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "shopify_collection_gid" TEXT NOT NULL,
    "handle"             TEXT,
    "title"              TEXT,
    "description"        TEXT,
    "shopify_updated_at" TIMESTAMP(3),
    "deleted_at"         TIMESTAMP(3),
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "collection_shop_gid_key" ON "collection"("shop_id","shopify_collection_gid");
CREATE INDEX "collection_shop_idx" ON "collection"("shop_id");

CREATE TABLE "product_collection" (
    "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"       UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "product_id"    UUID NOT NULL REFERENCES "product"("id") ON DELETE CASCADE,
    "collection_id" UUID NOT NULL REFERENCES "collection"("id") ON DELETE CASCADE,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "product_collection_key" ON "product_collection"("shop_id","product_id","collection_id");
CREATE INDEX "product_collection_shop_idx" ON "product_collection"("shop_id");

CREATE TABLE "metafield" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"     UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "owner_type"  TEXT NOT NULL,        -- 'product' | 'variant' | 'collection'
    "owner_id"    UUID NOT NULL,        -- internal id of the owner row
    "namespace"   TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "value"       TEXT,
    "value_type"  TEXT,
    "shopify_updated_at" TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "metafield_key" ON "metafield"("shop_id","owner_type","owner_id","namespace","key");
CREATE INDEX "metafield_shop_idx" ON "metafield"("shop_id");

-- ===========================================================================
-- Versioned search index
-- ===========================================================================
-- status: building -> validating -> validated -> active ; failed ; superseded ; rolled_back
CREATE TABLE "index_version" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"        UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "version"        INTEGER NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'building',
    "source"         TEXT NOT NULL DEFAULT 'full',   -- 'full' | 'incremental'
    "expected_count" INTEGER,
    "doc_count"      INTEGER NOT NULL DEFAULT 0,
    "error"          TEXT,
    "built_at"       TIMESTAMP(3),
    "validated_at"   TIMESTAMP(3),
    "activated_at"   TIMESTAMP(3),
    "failed_at"      TIMESTAMP(3),
    "superseded_at"  TIMESTAMP(3),
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "index_version_shop_version_key" ON "index_version"("shop_id","version");
-- At most ONE active version per shop (enforces safe atomic swap).
CREATE UNIQUE INDEX "index_version_one_active_per_shop" ON "index_version"("shop_id") WHERE "status" = 'active';
CREATE INDEX "index_version_shop_idx" ON "index_version"("shop_id");

-- The built (denormalized) search documents for a given index version.
-- NOTE: Phase 2 stores the document payload only. Full-text search columns
-- (tsvector), GIN indexes, ranking, typo/synonym handling are Phase 3+.
CREATE TABLE "product_search_doc" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"          UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "index_version_id" UUID NOT NULL REFERENCES "index_version"("id") ON DELETE CASCADE,
    "product_id"       UUID NOT NULL REFERENCES "product"("id") ON DELETE CASCADE,
    "shopify_product_gid" TEXT NOT NULL,
    "doc"              JSONB NOT NULL,
    "search_text"      TEXT NOT NULL DEFAULT '',
    "content_hash"     TEXT NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "product_search_doc_version_product_key" ON "product_search_doc"("shop_id","index_version_id","product_id");
CREATE INDEX "product_search_doc_version_idx" ON "product_search_doc"("index_version_id");
CREATE INDEX "product_search_doc_shop_idx" ON "product_search_doc"("shop_id");

CREATE TABLE "index_consistency_check" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"          UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "index_version_id" UUID NOT NULL REFERENCES "index_version"("id") ON DELETE CASCADE,
    "shopify_count"    INTEGER,
    "db_count"         INTEGER,
    "indexed_count"    INTEGER,
    "failed_count"     INTEGER,
    "status"           TEXT NOT NULL,    -- 'pass' | 'fail'
    "details"          JSONB,
    "checked_at"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "index_consistency_check_shop_idx" ON "index_consistency_check"("shop_id");
CREATE INDEX "index_consistency_check_version_idx" ON "index_consistency_check"("index_version_id");

-- ===========================================================================
-- Sync runs / failures / job audit
-- ===========================================================================
CREATE TABLE "sync_run" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"          UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "type"             TEXT NOT NULL,    -- 'bulk_full' | 'incremental'
    "status"           TEXT NOT NULL DEFAULT 'queued', -- queued|running|completed|failed|canceled
    "shopify_bulk_gid" TEXT,
    "bulk_status"      TEXT,
    "object_count"     INTEGER,
    "index_version_id" UUID REFERENCES "index_version"("id") ON DELETE SET NULL,
    "job_id"           TEXT,
    "error"            TEXT,
    "started_at"       TIMESTAMP(3),
    "finished_at"      TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "sync_run_shop_idx" ON "sync_run"("shop_id");
CREATE INDEX "sync_run_status_idx" ON "sync_run"("shop_id","status");

CREATE TABLE "sync_failure" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"     UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "sync_run_id" UUID REFERENCES "sync_run"("id") ON DELETE CASCADE,
    "stage"       TEXT NOT NULL,
    "error"       TEXT NOT NULL,
    "payload"     JSONB,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "sync_failure_shop_idx" ON "sync_failure"("shop_id");

-- Job audit + idempotency/dedup ledger. A unique (shop_id, dedupe_key) prevents
-- duplicate processing of the same logical job/event.
CREATE TABLE "job_audit" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "shop_id"     UUID NOT NULL REFERENCES "shop"("id") ON DELETE CASCADE,
    "queue"       TEXT NOT NULL,
    "job_id"      TEXT,
    "dedupe_key"  TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'enqueued', -- enqueued|started|completed|failed|skipped_duplicate
    "attempt"     INTEGER NOT NULL DEFAULT 0,
    "error"       TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "job_audit_dedupe_key" ON "job_audit"("shop_id","dedupe_key");
CREATE INDEX "job_audit_shop_idx" ON "job_audit"("shop_id");

-- ===========================================================================
-- Grants + RLS for all Phase 2 tenant tables
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "product","variant","collection","product_collection","metafield",
  "index_version","product_search_doc","index_consistency_check",
  "sync_run","sync_failure","job_audit"
TO app_runtime;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'product','variant','collection','product_collection','metafield',
    'index_version','product_search_doc','index_consistency_check',
    'sync_run','sync_failure','job_audit'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (shop_id = app_current_shop()) WITH CHECK (shop_id = app_current_shop());',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- ===========================================================================
-- pg-boss schema: app_runtime may create/manage the queue in its OWN schema
-- only (never public). Keeps app_runtime NOSUPERUSER/NOBYPASSRLS; tenant tables
-- remain RLS-protected. Job payloads carry a server-derived shop_id and handlers
-- always go through withShop(), so tenant data stays isolated.
-- ===========================================================================
-- pg-boss lives in its own schema, INSTALLED ONCE by app_owner
-- (`npm run pgboss:install`). app_runtime then runs with migrate:false and does
-- NOT need CREATE ON DATABASE or CREATE ON SCHEMA (least privilege). Default
-- privileges grant app_runtime access to the objects app_owner creates.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_owner;
GRANT USAGE ON SCHEMA pgboss TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA pgboss GRANT ALL ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO app_runtime;
