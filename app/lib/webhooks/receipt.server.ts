import {
  CLAIM_WEBHOOK_SQL,
  MARK_WEBHOOK_PROCESSED_SQL,
} from "~/lib/sql.server";
import { withShop } from "~/lib/tenant.server";

export interface WebhookIdentity {
  webhookId: string;
  topic: string;
  apiVersion?: string | null;
  payloadHash: string;
}

/**
 * Atomically claim a webhook for processing. Returns true on the FIRST delivery
 * of (shop_id, webhook_id); false for a duplicate or replay. Runs inside the
 * tenant context so the insert is RLS-bound to `shopId`.
 *
 * Callers should process the webhook only when this returns true, then call
 * markWebhookProcessed(). This makes handlers safe under Shopify's at-least-once
 * delivery guarantee.
 */
export async function claimWebhook(
  shopId: string,
  id: WebhookIdentity,
): Promise<boolean> {
  return withShop(shopId, async (tx) => {
    const rows = (await tx.$queryRawUnsafe(
      CLAIM_WEBHOOK_SQL,
      shopId,
      id.webhookId,
      id.topic,
      id.apiVersion ?? null,
      id.payloadHash,
    )) as Array<{ id: string }>;
    return rows.length > 0;
  });
}

export async function markWebhookProcessed(
  shopId: string,
  webhookId: string,
): Promise<void> {
  await withShop(shopId, async (tx) => {
    await tx.$executeRawUnsafe(MARK_WEBHOOK_PROCESSED_SQL, shopId, webhookId);
  });
}
