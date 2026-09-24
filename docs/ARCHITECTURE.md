# Architecture

This preserves the approved Phase 0 Revision 2 architecture. Phase 1 implements
only the foundation; later layers are shown for context and are **not** built yet.

## System (approved)

```
Shopify Admin
  -> Embedded Shopify App (React Router, App Bridge + Polaris web components)
  -> Node.js + TypeScript server
  -> PostgreSQL

Storefront (later phases)
  -> Theme App Extension / App Embed / App Blocks
  -> framework-free TypeScript widgets
  -> Shopify App Proxy
  -> Application server -> PostgreSQL

Background processing (later phases)
  -> pg-boss -> PostgreSQL

Shopify data (later phases)
  -> GraphQL Admin API -> Bulk Operations + Webhooks
  -> Sync/Indexer -> versioned PostgreSQL search index
```

Primary (and only) search engine: **PostgreSQL** (FTS + `pg_trgm` + `unaccent` +
rule-based ranking + rule-based NL query interpretation). No external search
engine, no pgvector/embeddings/transformers/LLM/AI APIs, no Redis.

## Phase 1 scope (built now)

- Embedded auth (managed install / token exchange), embedded shell.
- Multi-tenant foundation: `shop_id` on every tenant table, PostgreSQL RLS,
  `withShop()` tenant context, two-role DB model.
- Privacy + lifecycle webhooks (HMAC-verified, idempotent).
- Billing abstraction (provider-agnostic stub) + email abstraction (no-op).
- Schema v1 (foundation tables only).

## Data model

### Implemented in schema v1 (Phase 1 foundation)

| Table | Purpose | Tenant key |
|---|---|---|
| `session` | Shopify-managed auth sessions (infra; **not** RLS) | `shop` (domain) |
| `shop` | Tenant root; its `id` is the tenant key | `id` |
| `app_setting` | Per-shop settings (JSONB) | `shop_id` |
| `market` | Markets/currencies | `shop_id` |
| `webhook_receipt` | Webhook idempotency/receipt log | `shop_id` |
| `theme_compat_report` | Theme compatibility results | `shop_id` |
| `data_deletion_request` | Privacy webhook records | `shop_id` |
| `billing_subscription` | Billing abstraction persistence | `shop_id` |

### Implemented in Phase 2 (migration 0003)

Catalog (`product`, `variant`, `collection`, `product_collection`, `metafield`);
versioned index (`index_version`, `product_search_doc`, `index_consistency_check`);
sync/jobs (`sync_run`, `sync_failure`, `job_audit`). Background jobs via pg-boss
(own `pgboss` schema). See `docs/PHASE2.md` for the sync flow, job architecture,
index-version state machine, and rollback behavior.

### Preserved for later phases (NOT yet implemented)

`content_page`, `content_article`, `product_translation`,
`market_product_availability`, `market_price`; `search_term`, `product_facet`,
`product_metrics`; Filters, Search config, Merchandising, Recommendations/
bundles, Analytics (partitioned `analytics_event` + aggregates), Optional
(`back_in_stock_*`, `preorder_*`, `countdown_*`). Full-text search columns
(tsvector), ranking, typo/synonym handling are Phase 3+. These remain in the
Feature Matrix and are added by the phase that owns them.

## Tenancy & isolation

- Tenant identity is derived **server-side only** from the verified Shopify
  session (`session.shop`), validated as `<name>.myshopify.com`, then resolved
  to an internal `shop.id` via the `app_resolve_shop` SECURITY DEFINER function.
- `withShop(shopId, fn)` runs `fn` inside a transaction after
  `SET LOCAL app.shop_id`. RLS policies compare each row's `shop_id` to
  `app_current_shop()` (which returns NULL when unset → fail-closed).
- The runtime DB role (`app_runtime`) is `NOSUPERUSER` + `NOBYPASSRLS` and does
  not own the tables, so RLS is always enforced against it.

See `docs/SECURITY.md` for the full model and the deliberate exceptions.
