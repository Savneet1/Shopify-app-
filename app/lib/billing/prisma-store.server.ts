import type { BillingStatus, BillingStore, Subscription } from "./provider";
import { withShop } from "~/lib/tenant.server";

/**
 * Prisma-backed BillingStore (production). All access is RLS-bound via withShop.
 */
export class PrismaBillingStore implements BillingStore {
  async get(shopId: string): Promise<Subscription | null> {
    return withShop(shopId, async (tx) => {
      const row = await tx.billingSubscription.findFirst({ where: { shopId } });
      return row ? toSubscription(row) : null;
    });
  }

  async upsert(sub: Subscription): Promise<Subscription> {
    return withShop(sub.shopId, async (tx) => {
      const existing = await tx.billingSubscription.findFirst({
        where: { shopId: sub.shopId },
      });
      const data = {
        provider: sub.provider,
        plan: sub.plan,
        status: sub.status,
        test: sub.test,
        externalId: sub.externalId ?? null,
        activatedAt: sub.activatedAt ?? null,
        canceledAt: sub.canceledAt ?? null,
      };
      const row = existing
        ? await tx.billingSubscription.update({
            where: { id: existing.id },
            data,
          })
        : await tx.billingSubscription.create({
            data: { shopId: sub.shopId, ...data },
          });
      return toSubscription(row);
    });
  }
}

function toSubscription(row: {
  shopId: string;
  provider: string;
  plan: string;
  status: string;
  test: boolean;
  externalId: string | null;
  activatedAt: Date | null;
  canceledAt: Date | null;
}): Subscription {
  return {
    shopId: row.shopId,
    provider: row.provider,
    plan: row.plan,
    status: row.status as BillingStatus,
    test: row.test,
    externalId: row.externalId,
    activatedAt: row.activatedAt,
    canceledAt: row.canceledAt,
  };
}
