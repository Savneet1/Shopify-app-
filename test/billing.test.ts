import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryBillingStore } from "~/lib/billing/memory-store";
import { StubBillingProvider, DEFAULT_PLAN } from "~/lib/billing/stub";

describe("billing abstraction (stub)", () => {
  let provider: StubBillingProvider;
  const ctx = { shopId: "11111111-1111-1111-1111-111111111111" };

  beforeEach(() => {
    provider = new StubBillingProvider(new InMemoryBillingStore());
  });

  it("returns null before any subscription exists", async () => {
    expect(await provider.getSubscription(ctx)).toBeNull();
  });

  it("ensureSubscription creates an active free test plan", async () => {
    const sub = await provider.ensureSubscription(ctx);
    expect(sub.plan).toBe(DEFAULT_PLAN);
    expect(sub.status).toBe("active");
    expect(sub.test).toBe(true);
    expect(sub.provider).toBe("stub");
  });

  it("ensureSubscription is idempotent", async () => {
    const a = await provider.ensureSubscription(ctx);
    const b = await provider.ensureSubscription(ctx);
    expect(b.activatedAt?.getTime()).toBe(a.activatedAt?.getTime());
  });

  it("activate moves to an active paid plan (still test)", async () => {
    await provider.ensureSubscription(ctx);
    const sub = await provider.activate(ctx, "pro");
    expect(sub.plan).toBe("pro");
    expect(sub.status).toBe("active");
    expect(sub.test).toBe(true);
  });

  it("cancel marks the subscription canceled", async () => {
    await provider.activate(ctx, "pro");
    const sub = await provider.cancel(ctx);
    expect(sub.status).toBe("canceled");
    expect(sub.canceledAt).toBeInstanceOf(Date);
  });
});
