import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { withShopDomain } from "~/lib/tenant.server";
import { logger } from "~/lib/logger.server";

/**
 * app/scopes_update. Keeps our record of granted access scopes in sync when a
 * merchant approves/declines scope changes. (Phase 1 requests no scopes, but
 * the handler is in place so later phases don't need a fragile retrofit.)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  logger.info({ shop, topic }, "webhook received");

  const current = (payload as { current?: string[] } | undefined)?.current ?? [];
  const scopes = Array.isArray(current) ? current.join(",") : String(current);

  await withShopDomain(shop, async (tx, shopId) => {
    await tx.shop.update({
      where: { id: shopId },
      data: { accessScopes: scopes },
    });
  });

  return new Response(null, { status: 200 });
};
