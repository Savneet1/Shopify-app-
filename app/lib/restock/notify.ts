import type { Exec } from "~/lib/db/executor";
import type { EmailProvider } from "~/lib/email/provider";
import { isPermanentEmailError } from "~/lib/email/errors";
import { deriveUnsubToken } from "~/lib/crypto/secret.server";
import type { AvailabilityTransition } from "./availability";
import { effectiveAvailability } from "./availability";
import { loadRestockSettings } from "./settings";
import { normalizeLocale, confirmEmail, restockEmail } from "./templates";

/**
 * Phase 12.3 — notification fan-out + send. Creating the pending rows is a
 * SET-BASED insert per availability epoch (it does NOT grow a query per
 * subscriber); the actual sends are a bounded batch in the worker, re-checking
 * availability + visibility + suppression AT SEND TIME. The email NEVER appears
 * in a job payload — jobs carry the shop id only; the ledger carries subscription
 * ids. Logs/errors carry masked emails only.
 */

/** Only an absolute https URL (the shop's own onlineStoreUrl) is embedded. */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:") return null;
    if (!u.hostname || u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}

export interface LinkParts { appUrl: string; shopDomain: string; shopId: string; }

// Links carry the shop's internal id (`sid`, an opaque non-sensitive UUID) so
// the public route can bind RLS context WITHOUT a domain->id lookup that would
// create a shop row (storage-abuse safe). A forged sid simply matches no row.
export function unsubscribeUrl(parts: LinkParts, subscriptionId: string): string {
  const base = parts.appUrl.replace(/\/+$/, "");
  const t = deriveUnsubToken(parts.shopId, subscriptionId);
  return `${base}/restock/unsubscribe?s=${encodeURIComponent(subscriptionId)}&sid=${encodeURIComponent(parts.shopId)}&t=${encodeURIComponent(t)}`;
}

export function confirmUrl(parts: LinkParts, subscriptionId: string, rawConfirmToken: string): string {
  const base = parts.appUrl.replace(/\/+$/, "");
  return `${base}/restock/confirm?s=${encodeURIComponent(subscriptionId)}&sid=${encodeURIComponent(parts.shopId)}&t=${encodeURIComponent(rawConfirmToken)}`;
}

/** List-Unsubscribe header value (one-click, RFC 8058). */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

/**
 * Create one pending notification per confirmed, non-suppressed subscription on
 * each transition target, at the transition's epoch. Idempotent via the unique
 * (shop, subscription, epoch) index — a replay/re-detection inserts nothing.
 * One statement per transition; does not grow per subscriber.
 */
export async function createPendingNotifications(
  exec: Exec, shopId: string, transitions: AvailabilityTransition[],
): Promise<number> {
  let created = 0;
  for (const t of transitions) {
    const n = await exec.run(
      `INSERT INTO restock_notification (shop_id, subscription_id, epoch, status, created_at)
       SELECT s.shop_id, s.id, $3::int, 'pending', now()
       FROM back_in_stock_subscription s
       WHERE s.shop_id=$1::uuid AND s.product_id=$2::uuid AND s.variant_key=$4
         AND s.status='confirmed'
         AND NOT EXISTS (SELECT 1 FROM restock_suppression x WHERE x.shop_id=s.shop_id AND x.email_hash=s.email_hash)
       ON CONFLICT (shop_id, subscription_id, epoch) DO NOTHING`,
      [shopId, t.productId, t.epoch, t.variantKey],
    );
    created += n;
  }
  return created;
}

export interface DrainDeps {
  provider: EmailProvider;
  links: LinkParts;
  shopName: string;
  now?: Date;
}
export interface DrainResult { sent: number; skipped: number; bounced: number; transient: number; }

interface PendingRow {
  nid: string; subscription_id: string; epoch: number;
  product_id: string; variant_key: string; email: string; locale: string; status: string;
}

/**
 * Send a bounded batch of pending restock notifications for one shop (RLS-scoped
 * via the caller's exec). Re-checks availability + visibility + suppression +
 * subscription status AT SEND TIME. One email per subscription; never re-mails a
 * product that is again sold out / unpublished. Must run as a per-shop singleton
 * (the worker enqueues a singleton drain job) so no row is sent twice.
 */
export async function drainRestockNotifications(
  exec: Exec, shopId: string, deps: DrainDeps,
): Promise<DrainResult> {
  const settings = await loadRestockSettings(exec, shopId);
  const limit = settings.sendRatePerRun;
  const res: DrainResult = { sent: 0, skipped: 0, bounced: 0, transient: 0 };

  const pending = await exec.rows<PendingRow>(
    `SELECT n.id AS nid, n.subscription_id, n.epoch, s.product_id, s.variant_key, s.email, s.locale, s.status
     FROM restock_notification n
     JOIN back_in_stock_subscription s ON s.id = n.subscription_id AND s.shop_id = n.shop_id
     WHERE n.shop_id=$1::uuid AND n.status='pending'
     ORDER BY n.created_at ASC
     LIMIT $2::int`,
    [shopId, limit],
  );

  for (const row of pending) {
    // Subscription must still be confirmed (one-send-per-subscription).
    if (row.status !== "confirmed") { await mark(exec, shopId, row.nid, "skipped", "not-confirmed"); res.skipped++; continue; }

    // Suppression re-check at send time.
    const sup = await exec.rows<{ one: number }>(
      `SELECT 1 one FROM restock_suppression r
       JOIN back_in_stock_subscription s ON s.email_hash=r.email_hash AND s.shop_id=r.shop_id
       WHERE r.shop_id=$1::uuid AND s.id=$2::uuid LIMIT 1`,
      [shopId, row.subscription_id],
    );
    if (sup.length > 0) { await mark(exec, shopId, row.nid, "skipped", "suppressed"); res.skipped++; continue; }

    // Availability + visibility re-check at send time.
    const eff = await effectiveAvailability(exec, shopId, row.product_id, row.variant_key);
    if (!eff.visible || !eff.available) { await mark(exec, shopId, row.nid, "skipped", "unavailable"); res.skipped++; continue; }

    const locale = normalizeLocale(row.locale);
    const unsub = unsubscribeUrl(deps.links, row.subscription_id);
    const body = restockEmail(locale, {
      shopName: deps.shopName,
      productTitle: eff.title ?? "your item",
      productUrl: safeHttpsUrl(eff.url),
      unsubscribeUrl: unsub,
    });

    try {
      await deps.provider.send({
        to: row.email,
        subject: body.subject,
        text: body.text,
        html: body.html,
        headers: { ...listUnsubscribeHeaders(unsub), "Auto-Submitted": "auto-generated" },
      });
      // Mark sent + flip the subscription to 'notified' so it is never re-sent.
      await mark(exec, shopId, row.nid, "sent", null);
      await exec.run(
        `UPDATE back_in_stock_subscription SET status='notified', notified_at=now(), updated_at=now()
         WHERE shop_id=$1::uuid AND id=$2::uuid AND status='confirmed'`,
        [shopId, row.subscription_id],
      );
      res.sent++;
    } catch (err) {
      if (isPermanentEmailError(err)) {
        await mark(exec, shopId, row.nid, "bounced", "permanent");
        await exec.run(
          `UPDATE back_in_stock_subscription SET status='bounced', updated_at=now()
           WHERE shop_id=$1::uuid AND id=$2::uuid`,
          [shopId, row.subscription_id],
        );
        // Suppress a bounced address so it is never re-mailed.
        await exec.run(
          `INSERT INTO restock_suppression (shop_id, email_hash, reason, created_at)
           SELECT shop_id, email_hash, 'bounced', now() FROM back_in_stock_subscription
           WHERE shop_id=$1::uuid AND id=$2::uuid
           ON CONFLICT (shop_id, email_hash) DO NOTHING`,
          [shopId, row.subscription_id],
        );
        res.bounced++;
      } else {
        // Transient: leave pending for a later run.
        res.transient++;
      }
    }
  }
  return res;
}

async function mark(exec: Exec, shopId: string, nid: string, status: string, error: string | null): Promise<void> {
  await exec.run(
    `UPDATE restock_notification
     SET status=$3, error=$4, sent_at=CASE WHEN $3='sent' THEN now() ELSE sent_at END
     WHERE shop_id=$1::uuid AND id=$2::uuid AND status='pending'`,
    [shopId, nid, status, error],
  );
}
