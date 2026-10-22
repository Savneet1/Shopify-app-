import type { Exec } from "~/lib/db/executor";
import { emailHash, getShopPepper } from "~/lib/crypto/secret.server";
import { normalizeEmail, maskEmail } from "./email";

/**
 * Phase 12.6 — admin-side queries for the restock dashboard. Emails are shown
 * MASKED; search is by EXACT email (hashed, never plaintext LIKE). Deletions are
 * RLS-scoped to the shop.
 */

export interface SubscriptionCounts {
  pending: number; confirmed: number; notified: number; unsubscribed: number; bounced: number; total: number;
}

export async function subscriptionCounts(exec: Exec, shopId: string): Promise<SubscriptionCounts> {
  const rows = await exec.rows<{ status: string; n: number }>(
    `SELECT status, count(*)::int n FROM back_in_stock_subscription WHERE shop_id=$1::uuid GROUP BY status`,
    [shopId],
  );
  const c: SubscriptionCounts = { pending: 0, confirmed: 0, notified: 0, unsubscribed: 0, bounced: 0, total: 0 };
  for (const r of rows) {
    if (r.status in c) (c as unknown as Record<string, number>)[r.status] = Number(r.n);
    c.total += Number(r.n);
  }
  return c;
}

export interface NotificationStats { pending: number; sent: number; bounced: number; skipped: number; }

export async function notificationStats(exec: Exec, shopId: string): Promise<NotificationStats> {
  const rows = await exec.rows<{ status: string; n: number }>(
    `SELECT status, count(*)::int n FROM restock_notification WHERE shop_id=$1::uuid GROUP BY status`,
    [shopId],
  );
  const s: NotificationStats = { pending: 0, sent: 0, bounced: 0, skipped: 0 };
  for (const r of rows) if (r.status in s) (s as unknown as Record<string, number>)[r.status] = Number(r.n);
  return s;
}

export interface AdminSubscriptionRow {
  id: string;
  maskedEmail: string;
  status: string;
  shopifyProductGid: string;
  variantGid: string | null;
  locale: string;
  source: string | null;
  createdAt: string;
}

/** List subscriptions (newest first), optionally filtered to one EXACT email
 * (matched by hash). Emails are returned MASKED only. */
export async function listSubscriptions(
  exec: Exec, shopId: string, opts: { emailQuery?: string | null; limit?: number } = {},
): Promise<AdminSubscriptionRow[]> {
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 200)));
  let where = `shop_id=$1::uuid`;
  const params: unknown[] = [shopId];
  if (opts.emailQuery) {
    const { email, valid } = normalizeEmail(opts.emailQuery);
    if (!valid || !email) return []; // invalid query → no rows (never leaks)
    const pepper = await getShopPepper(exec, shopId);
    params.push(emailHash(pepper, shopId, email));
    where += ` AND email_hash=$${params.length}`;
  }
  params.push(limit);
  const rows = await exec.rows<{
    id: string; email: string; status: string; shopify_product_gid: string;
    variant_gid: string | null; locale: string; source: string | null; created_at: string;
  }>(
    `SELECT id, email, status, shopify_product_gid, variant_gid, locale, source, created_at
     FROM back_in_stock_subscription WHERE ${where}
     ORDER BY created_at DESC LIMIT $${params.length}::int`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    maskedEmail: maskEmail(r.email),
    status: r.status,
    shopifyProductGid: r.shopify_product_gid,
    variantGid: r.variant_gid,
    locale: r.locale,
    source: r.source,
    createdAt: r.created_at,
  }));
}

export async function deleteSubscription(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM back_in_stock_subscription WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

/** Delete ALL subscriptions for one exact email (hashed) and suppress it so it
 * is not re-collectible by accident. Returns rows deleted. */
export async function deleteAllForEmail(exec: Exec, shopId: string, rawEmail: string): Promise<number> {
  const { email, valid } = normalizeEmail(rawEmail);
  if (!valid || !email) return 0;
  const pepper = await getShopPepper(exec, shopId);
  const hash = emailHash(pepper, shopId, email);
  const n = await exec.run(
    `DELETE FROM back_in_stock_subscription WHERE shop_id=$1::uuid AND email_hash=$2`,
    [shopId, hash],
  );
  await exec.run(
    `INSERT INTO restock_suppression (shop_id, email_hash, reason, created_at)
     VALUES ($1::uuid,$2,'unsubscribed', now()) ON CONFLICT (shop_id, email_hash) DO NOTHING`,
    [shopId, hash],
  );
  return n;
}
