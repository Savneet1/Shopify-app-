import { withShop, type TenantTx } from "~/lib/tenant.server";
import { logger } from "~/lib/logger.server";

export type ComplianceTopic =
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact";

export interface ComplianceInput {
  shopId: string;
  topic: ComplianceTopic;
  shopifyCustomerId?: string | null;
  customerEmail?: string | null;
  payload: unknown;
}

/**
 * Process a mandatory privacy webhook, tenant-scoped.
 *
 * Phase 1 data reality: this app stores NO customer personal data yet (no
 * access scopes, no catalog/customer sync — those arrive in later phases). So:
 *
 *  - customers/data_request : record the request; there is no customer PII to
 *    return, so it is marked "no_data".
 *  - customers/redact       : record; nothing to erase -> "no_data".
 *  - shop/redact            : record; erase this shop's tenant-owned rows and
 *    tombstone the shop (uninstalledAt). The shop row itself is removed by an
 *    owner-run maintenance job (runtime role has no DELETE policy on `shop`).
 *
 * Every write is RLS-bound to `shopId` via withShop.
 */
export async function processCompliance(input: ComplianceInput): Promise<void> {
  const { shopId, topic } = input;
  await withShop(shopId, async (tx) => {
    await tx.dataDeletionRequest.create({
      data: {
        shopId,
        topic,
        shopifyCustomerId: input.shopifyCustomerId ?? null,
        customerEmail: input.customerEmail ?? null,
        // Prisma's generated JSON input type accepts a plain JSON value here.
        payload: (input.payload ?? {}) as object,
        status: topic === "shop/redact" ? "processing" : "no_data",
        processedAt: topic === "shop/redact" ? null : new Date(),
      },
    });

    if (topic === "shop/redact") {
      await eraseShopData(tx, shopId);
    }
  });

  logger.info({ shopId, topic }, "processed compliance webhook");
}

/**
 * Delete this shop's tenant-owned data (RLS ensures only this shop's rows are
 * affected). `shop` itself is tombstoned rather than deleted here.
 */
async function eraseShopData(tx: TenantTx, shopId: string): Promise<void> {
  await tx.appSetting.deleteMany({ where: { shopId } });
  await tx.market.deleteMany({ where: { shopId } });
  await tx.themeCompatReport.deleteMany({ where: { shopId } });
  await tx.billingSubscription.deleteMany({ where: { shopId } });
  // webhook_receipt + data_deletion_request are audit records; retained.
  await tx.shop.update({
    where: { id: shopId },
    data: { uninstalledAt: new Date() },
  });
}
