import type { BillingProvider } from "./provider";
import { PrismaBillingStore } from "./prisma-store.server";
import { StubBillingProvider } from "./stub";

export * from "./provider";
export { StubBillingProvider } from "./stub";

/**
 * Default billing provider for the running app (Phase 1 = stub, DB-backed).
 * Replace with a ShopifyBillingProvider in the billing phase without touching
 * callers.
 */
export const billing: BillingProvider = new StubBillingProvider(
  new PrismaBillingStore(),
);
