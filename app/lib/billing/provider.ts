/**
 * Provider-agnostic billing abstraction.
 *
 * Phase 1 requirement: a billing ABSTRACTION/STUB that does not lock the app
 * into a billing provider. The real Shopify Billing integration
 * (appSubscriptionCreate / managed pricing) is deferred to the phase that
 * defines plans, and must be verified against current Shopify docs then.
 *
 * The interface is written so that a ShopifyBillingProvider can later implement
 * it without changing callers.
 */

export type BillingStatus = "inactive" | "pending" | "active" | "canceled";

export interface Subscription {
  shopId: string;
  provider: string;
  plan: string;
  status: BillingStatus;
  test: boolean;
  externalId?: string | null;
  activatedAt?: Date | null;
  canceledAt?: Date | null;
}

export interface BillingContext {
  shopId: string;
}

export interface BillingProvider {
  /** Current subscription for the shop, or null if none. */
  getSubscription(ctx: BillingContext): Promise<Subscription | null>;
  /** Ensure a subscription row exists (creates a default if absent). */
  ensureSubscription(ctx: BillingContext, plan?: string): Promise<Subscription>;
  /** Move the subscription to active on the given plan. */
  activate(ctx: BillingContext, plan: string): Promise<Subscription>;
  /** Cancel the current subscription. */
  cancel(ctx: BillingContext): Promise<Subscription>;
}

/** Persistence seam so the provider logic is testable without a database. */
export interface BillingStore {
  get(shopId: string): Promise<Subscription | null>;
  upsert(sub: Subscription): Promise<Subscription>;
}
