import { withShopExec } from "~/lib/tenant.server";
import { getEmailProvider } from "~/lib/email/factory";
import { drainRestockNotifications, type DrainResult } from "./notify";

/**
 * Phase 12.3 — worker-side drain for one shop. Assembles the per-shop email
 * provider + link context and sends a bounded batch of pending notifications,
 * RLS-scoped. When email is NOT configured, nothing is sent and pending rows are
 * left for a later run (subscriptions are still collected). The job that calls
 * this is a per-shop singleton, so no notification is ever sent twice.
 */
export async function runRestockDrainForShop(shopId: string): Promise<DrainResult> {
  return withShopExec(shopId, async (e) => {
    const { provider, configured } = await getEmailProvider(e, shopId);
    if (!configured) return { sent: 0, skipped: 0, bounced: 0, transient: 0 };
    const info = await e.rows<{ shop_domain: string; name: string | null }>(
      `SELECT shop_domain, name FROM shop WHERE id=$1::uuid`,
      [shopId],
    );
    const shopDomain = info[0]?.shop_domain ?? "";
    const shopName = info[0]?.name || shopDomain || "the store";
    const appUrl = process.env.SHOPIFY_APP_URL || "";
    return drainRestockNotifications(e, shopId, {
      provider,
      shopName,
      links: { appUrl, shopDomain, shopId },
    });
  });
}
