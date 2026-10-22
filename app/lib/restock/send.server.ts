import { withShopExec } from "~/lib/tenant.server";
import type { Exec } from "~/lib/db/executor";
import type { EmailProvider } from "~/lib/email/provider";
import { getEmailProvider } from "~/lib/email/factory";
import { generateToken, hashToken } from "~/lib/crypto/secret.server";
import { confirmUrl, unsubscribeUrl, listUnsubscribeHeaders, type LinkParts } from "./notify";
import { confirmEmail, normalizeLocale } from "./templates";
import { CONFIRM_TTL_HOURS } from "./subscriptions";

/**
 * Phase 12.1 Q2 — ASYNC double-opt-in confirmation send, run by the worker (the
 * public subscribe request does NO outbound I/O). Loads the subscription, mints
 * a FRESH confirm token (storing only its hash + expiry — the raw token lives
 * only inside the email), and sends via the provider's retry/permanent/transient
 * handling. Exactly-once: `confirm_sent_at` is set on success and a replayed job
 * that sees it set sends nothing. Never mails an already-confirmed / suppressed /
 * unsubscribed / notified row. When email is not configured, nothing is sent.
 */
export interface ConfirmSendDeps { provider?: EmailProvider; now?: Date; appUrl?: string }
export type ConfirmSendResult = { sent: boolean; reason?: string };

export async function runRestockConfirm(
  shopId: string, subscriptionId: string, deps: ConfirmSendDeps = {},
): Promise<ConfirmSendResult> {
  return withShopExec(shopId, (e) => sendConfirmWithExec(e, shopId, subscriptionId, deps));
}

export async function sendConfirmWithExec(
  exec: Exec, shopId: string, subscriptionId: string, deps: ConfirmSendDeps = {},
): Promise<ConfirmSendResult> {
  const now = deps.now ?? new Date();
  const rows = await exec.rows<{
    id: string; status: string; locale: string; email: string; email_hash: string;
    confirm_sent_at: string | null; title: string | null;
  }>(
    `SELECT s.id, s.status, s.locale, s.email, s.email_hash, s.confirm_sent_at, psd.title
     FROM back_in_stock_subscription s
     LEFT JOIN index_version iv ON iv.shop_id=s.shop_id AND iv.status='active'
     LEFT JOIN product_search_doc psd ON psd.shop_id=s.shop_id AND psd.index_version_id=iv.id AND psd.product_id=s.product_id
     WHERE s.shop_id=$1::uuid AND s.id=$2::uuid`,
    [shopId, subscriptionId],
  );
  const r = rows[0];
  if (!r) return { sent: false, reason: "gone" };
  if (r.status !== "pending") return { sent: false, reason: "not-pending" };   // confirmed/unsub/notified
  if (r.confirm_sent_at) return { sent: false, reason: "already-sent" };         // replay → nothing

  // Suppression re-check at send time.
  const sup = await exec.rows<{ one: number }>(
    `SELECT 1 one FROM restock_suppression WHERE shop_id=$1::uuid AND email_hash=$2 LIMIT 1`,
    [shopId, r.email_hash],
  );
  if (sup.length > 0) return { sent: false, reason: "suppressed" };

  const { provider, configured } = deps.provider
    ? { provider: deps.provider, configured: true }
    : await getEmailProvider(exec, shopId);
  if (!configured) return { sent: false, reason: "not-configured" };            // nothing sent; stays pending

  // Mint a FRESH confirm token; persist only its hash + expiry.
  const rawToken = generateToken();
  const expires = new Date(now.getTime() + CONFIRM_TTL_HOURS * 3600_000).toISOString();
  await exec.run(
    `UPDATE back_in_stock_subscription SET confirm_token_hash=$3, confirm_expires_at=$4::timestamptz, updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid AND status='pending'`,
    [shopId, subscriptionId, hashToken(rawToken), expires],
  );

  const info = await exec.rows<{ shop_domain: string; name: string | null }>(
    `SELECT shop_domain, name FROM shop WHERE id=$1::uuid`, [shopId],
  );
  const shopDomain = info[0]?.shop_domain ?? "";
  const shopName = info[0]?.name || shopDomain || "the store";
  const links: LinkParts = { appUrl: deps.appUrl || process.env.SHOPIFY_APP_URL || "", shopDomain, shopId };
  const locale = normalizeLocale(r.locale);
  const body = confirmEmail(locale, {
    shopName, productTitle: r.title ?? "your item",
    confirmUrl: confirmUrl(links, subscriptionId, rawToken),
    unsubscribeUrl: unsubscribeUrl(links, subscriptionId),
  });

  // A provider failure throws (transient → pg-boss retries; permanent → bounded
  // by retryLimit). confirm_sent_at is set ONLY on success → exactly-once.
  await provider.send({
    to: r.email, subject: body.subject, text: body.text, html: body.html,
    headers: { ...listUnsubscribeHeaders(unsubscribeUrl(links, subscriptionId)), "Auto-Submitted": "auto-generated" },
  });
  await exec.run(
    `UPDATE back_in_stock_subscription SET confirm_sent_at=now(), updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, subscriptionId],
  );
  return { sent: true };
}
