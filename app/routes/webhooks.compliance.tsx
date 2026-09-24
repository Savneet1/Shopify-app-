import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { resolveShopId } from "~/lib/tenant.server";
import {
  claimWebhook,
  markWebhookProcessed,
} from "~/lib/webhooks/receipt.server";
import { sha256Hex } from "~/lib/webhooks/hmac.server";
import {
  processCompliance,
  type ComplianceTopic,
} from "~/lib/webhooks/compliance.server";
import { purgeShopJobs } from "~/lib/jobs/purge.server";
import { logger } from "~/lib/logger.server";

function normalizeTopic(topic: string): ComplianceTopic | null {
  switch (topic.toUpperCase().replace(/\//g, "_")) {
    case "CUSTOMERS_DATA_REQUEST":
      return "customers/data_request";
    case "CUSTOMERS_REDACT":
      return "customers/redact";
    case "SHOP_REDACT":
      return "shop/redact";
    default:
      return null;
  }
}

/**
 * Single endpoint for the three mandatory compliance topics.
 * authenticate.webhook verifies the HMAC (returns 401 on an invalid signature,
 * as Shopify requires). Processing is idempotent via the webhook_receipt claim,
 * so duplicate/replayed deliveries are safe.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId, apiVersion } =
    await authenticate.webhook(request);

  const complianceTopic = normalizeTopic(topic);
  if (!complianceTopic) {
    logger.warn({ shop, topic }, "unrecognised compliance topic; acking");
    return new Response(null, { status: 200 });
  }

  const shopId = await resolveShopId(shop);
  const body = (payload ?? {}) as Record<string, any>;
  const payloadHash = sha256Hex(JSON.stringify(body));
  const dedupeId = webhookId ?? `${topic}:${payloadHash}`;

  const isFirstDelivery = await claimWebhook(shopId, {
    webhookId: dedupeId,
    topic,
    apiVersion,
    payloadHash,
  });

  if (!isFirstDelivery) {
    logger.info(
      { shop, topic, webhookId: dedupeId },
      "duplicate compliance webhook; skipped",
    );
    return new Response(null, { status: 200 });
  }

  await processCompliance({
    shopId,
    topic: complianceTopic,
    shopifyCustomerId: body?.customer?.id ? String(body.customer.id) : null,
    customerEmail: body?.customer?.email ?? null,
    payload: body,
  });

  // shop/redact: also purge this shop's background jobs (queued + dead-lettered).
  if (complianceTopic === "shop/redact") {
    await purgeShopJobs(shopId).catch(() => {});
  }

  await markWebhookProcessed(shopId, dedupeId);
  return new Response(null, { status: 200 });
};
