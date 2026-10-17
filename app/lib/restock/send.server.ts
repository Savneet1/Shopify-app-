import type { Exec } from "~/lib/db/executor";
import { getEmailProvider } from "~/lib/email/factory";
import { confirmUrl, unsubscribeUrl, listUnsubscribeHeaders, type LinkParts } from "./notify";
import { confirmEmail, normalizeLocale } from "./templates";

/**
 * Phase 12.2 — send the double-opt-in CONFIRMATION email. Called from the
 * subscribe endpoint only for a freshly created row, BEFORE any notification is
 * ever possible. Best-effort: a provider failure never affects the (generic)
 * public response. When email is not configured, nothing is sent (the pending
 * row simply waits; it will never be mailed an alert while unconfirmed).
 */
export async function sendConfirmationEmail(
  exec: Exec, shopId: string, subscriptionId: string, rawConfirmToken: string, toEmail: string,
): Promise<boolean> {
  const { provider, configured } = await getEmailProvider(exec, shopId);
  if (!configured) return false;

  // Title comes from the VISIBLE active-version doc only (never drafts).
  const rows = await exec.rows<{ locale: string; title: string | null }>(
    `SELECT s.locale, psd.title
     FROM back_in_stock_subscription s
     LEFT JOIN index_version iv ON iv.shop_id=s.shop_id AND iv.status='active'
     LEFT JOIN product_search_doc psd ON psd.shop_id=s.shop_id AND psd.index_version_id=iv.id AND psd.product_id=s.product_id
     WHERE s.shop_id=$1::uuid AND s.id=$2::uuid`,
    [shopId, subscriptionId],
  );
  const locale = normalizeLocale(rows[0]?.locale);
  const title = rows[0]?.title ?? "your item";

  const info = await exec.rows<{ shop_domain: string; name: string | null }>(
    `SELECT shop_domain, name FROM shop WHERE id=$1::uuid`,
    [shopId],
  );
  const shopDomain = info[0]?.shop_domain ?? "";
  const shopName = info[0]?.name || shopDomain || "the store";
  const links: LinkParts = { appUrl: process.env.SHOPIFY_APP_URL || "", shopDomain, shopId };

  const cUrl = confirmUrl(links, subscriptionId, rawConfirmToken);
  const uUrl = unsubscribeUrl(links, subscriptionId);
  const body = confirmEmail(locale, { shopName, productTitle: title, confirmUrl: cUrl, unsubscribeUrl: uUrl });

  try {
    await provider.send({
      to: toEmail,
      subject: body.subject,
      text: body.text,
      html: body.html,
      headers: { ...listUnsubscribeHeaders(uUrl), "Auto-Submitted": "auto-generated" },
    });
    return true;
  } catch {
    return false; // best-effort; the public response is unaffected
  }
}
