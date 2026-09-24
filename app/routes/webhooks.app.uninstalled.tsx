import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { getPrisma } from "~/db.server";
import { resolveShopId, withShopDomain } from "~/lib/tenant.server";
import { purgeShopJobs } from "~/lib/jobs/purge.server";
import { logger } from "~/lib/logger.server";

/**
 * app/uninstalled. authenticate.webhook verifies the HMAC (401 on mismatch).
 * We remove the shop's sessions and tombstone the shop record. Full data
 * erasure follows the shop/redact compliance webhook.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  logger.info({ shop, topic }, "webhook received");

  // Session table is auth infrastructure (no RLS); delete by shop domain.
  await getPrisma().session.deleteMany({ where: { shop } });

  const shopId = await resolveShopId(shop);
  await withShopDomain(shop, async (tx, id) => {
    await tx.shop.update({ where: { id }, data: { uninstalledAt: new Date() } });
  });

  // Cancel/purge this shop's queued + dead-lettered jobs so nothing runs for a
  // removed shop.
  await purgeShopJobs(shopId).catch((err) =>
    logger.warn({ shop, err: String(err) }, "purgeShopJobs failed on uninstall"),
  );

  return new Response(null, { status: 200 });
};
