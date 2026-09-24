/**
 * Canonical SQL fragments used by the tenant data layer.
 *
 * Kept in one Prisma-free module so the exact SQL that runs in production
 * (via Prisma `$executeRawUnsafe` / `$queryRawUnsafe`) is the SAME text the
 * database tests exercise directly. This avoids drift between "what we ship"
 * and "what we test".
 */

/** Set the tenant context for the current transaction (SET LOCAL semantics). */
export const SET_LOCAL_SHOP_SQL =
  "SELECT set_config('app.shop_id', $1, true)";

/** Bootstrap: authenticated shop domain -> shop.id (SECURITY DEFINER upsert). */
export const RESOLVE_SHOP_SQL = "SELECT app_resolve_shop($1) AS id";

/**
 * Idempotent webhook claim. Returns a row only on the FIRST delivery of a given
 * (shop_id, webhook_id). A duplicate/replay returns zero rows -> skip work.
 * Must run inside a withShop() transaction so RLS binds shop_id to the context.
 */
export const CLAIM_WEBHOOK_SQL = `
INSERT INTO webhook_receipt (shop_id, webhook_id, topic, api_version, payload_hash)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (shop_id, webhook_id) DO NOTHING
RETURNING id`;

/** Mark a previously-claimed webhook as processed. */
export const MARK_WEBHOOK_PROCESSED_SQL = `
UPDATE webhook_receipt SET status = 'processed', processed_at = now()
WHERE shop_id = $1::uuid AND webhook_id = $2`;
