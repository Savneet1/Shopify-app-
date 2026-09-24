import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { resolveShopId } from "~/lib/tenant.server";
import { mapCatalogWebhook } from "~/lib/catalog/webhook-map";
import { enqueueIncremental } from "~/lib/jobs/queue";
import { logger } from "~/lib/logger.server";

/**
 * Catalog change webhooks (products/collections create|update|delete).
 * authenticate.webhook verifies the HMAC. We map the payload to a tenant-scoped
 * incremental job and enqueue it; the worker applies it under withShop and
 * refreshes the active index in place. dedupeKey (topic:webhookId) makes
 * duplicate deliveries safe.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);
  const shopId = await resolveShopId(shop);
  const mapped = mapCatalogWebhook(
    topic,
    payload,
    shopId,
    webhookId ?? `${topic}:${Date.now()}`,
  );
  if (mapped) {
    await enqueueIncremental(mapped);
  } else {
    logger.warn({ shop, topic }, "unmapped catalog webhook topic");
  }
  return new Response(null, { status: 200 });
};
