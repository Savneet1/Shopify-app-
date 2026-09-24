import type {
  BillingContext,
  BillingProvider,
  BillingStore,
  Subscription,
} from "./provider";

export const STUB_PROVIDER = "stub";
export const DEFAULT_PLAN = "free";

/**
 * Phase 1 billing provider. Persists subscription state through a BillingStore
 * but performs NO real charges. Every subscription is flagged `test: true`.
 * Swapping in a ShopifyBillingProvider later requires no caller changes.
 */
export class StubBillingProvider implements BillingProvider {
  constructor(private readonly store: BillingStore) {}

  async getSubscription(ctx: BillingContext): Promise<Subscription | null> {
    return this.store.get(ctx.shopId);
  }

  async ensureSubscription(
    ctx: BillingContext,
    plan: string = DEFAULT_PLAN,
  ): Promise<Subscription> {
    const existing = await this.store.get(ctx.shopId);
    if (existing) return existing;
    return this.store.upsert({
      shopId: ctx.shopId,
      provider: STUB_PROVIDER,
      plan,
      status: plan === DEFAULT_PLAN ? "active" : "inactive",
      test: true,
      activatedAt: plan === DEFAULT_PLAN ? new Date() : null,
      canceledAt: null,
      externalId: null,
    });
  }

  async activate(ctx: BillingContext, plan: string): Promise<Subscription> {
    return this.store.upsert({
      shopId: ctx.shopId,
      provider: STUB_PROVIDER,
      plan,
      status: "active",
      test: true,
      activatedAt: new Date(),
      canceledAt: null,
      externalId: null,
    });
  }

  async cancel(ctx: BillingContext): Promise<Subscription> {
    const existing = await this.store.get(ctx.shopId);
    return this.store.upsert({
      shopId: ctx.shopId,
      provider: STUB_PROVIDER,
      plan: existing?.plan ?? DEFAULT_PLAN,
      status: "canceled",
      test: true,
      activatedAt: existing?.activatedAt ?? null,
      canceledAt: new Date(),
      externalId: existing?.externalId ?? null,
    });
  }
}
