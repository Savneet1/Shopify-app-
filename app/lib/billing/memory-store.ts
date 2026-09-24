import type { BillingStore, Subscription } from "./provider";

/** In-memory BillingStore for tests and local experimentation. */
export class InMemoryBillingStore implements BillingStore {
  private readonly rows = new Map<string, Subscription>();

  async get(shopId: string): Promise<Subscription | null> {
    return this.rows.get(shopId) ?? null;
  }

  async upsert(sub: Subscription): Promise<Subscription> {
    this.rows.set(sub.shopId, { ...sub });
    return { ...sub };
  }
}
