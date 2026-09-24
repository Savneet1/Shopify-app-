import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { logger } from "~/lib/logger.server";

/**
 * bulk_operations/finish. Our full-sync job polls the operation to completion,
 * so this handler only needs to acknowledge the notification (a future
 * optimisation could hand the finished operation id to a waiting job instead of
 * polling). HMAC is verified by authenticate.webhook.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  logger.info(
    { shop, topic, status: (payload as { status?: string } | undefined)?.status },
    "bulk operation finished",
  );
  return new Response(null, { status: 200 });
};
