import type { Exec } from "~/lib/db/executor";
import { recordAvailabilityTransitions } from "./availability";
import { createPendingNotifications } from "./notify";

/**
 * Phase 12.3 — detection entry point called from the catalog apply path (inside
 * the same RLS transaction as the doc refresh, so transition state + pending
 * notification rows are atomic with the availability change).
 *
 * Gated on "does any confirmed subscription exist for this product?" so a shop
 * that uses no back-in-stock alerts pays only ONE extra existence SELECT per
 * product upsert and writes NOTHING new — keeping behaviour byte-identical for
 * shops without subscriptions. The fan-out (pending-row creation) is set-based
 * and does not grow a query per subscriber.
 */
export async function detectAndQueueRestock(
  exec: Exec, shopId: string, productId: string,
): Promise<{ transitions: number; created: number }> {
  const has = await exec.rows<{ one: number }>(
    `SELECT 1 AS one FROM back_in_stock_subscription
     WHERE shop_id=$1::uuid AND product_id=$2::uuid AND status='confirmed' LIMIT 1`,
    [shopId, productId],
  );
  if (has.length === 0) return { transitions: 0, created: 0 };
  const transitions = await recordAvailabilityTransitions(exec, shopId, productId);
  const created = await createPendingNotifications(exec, shopId, transitions);
  return { transitions: transitions.length, created };
}
