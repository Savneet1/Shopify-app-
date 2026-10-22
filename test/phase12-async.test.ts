import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { subscribe, confirmSubscription } from "~/lib/restock/subscriptions";
import { sendConfirmWithExec } from "~/lib/restock/send.server";
import { runSubscribeRequest } from "~/lib/restock/subscribe-request.server";
import { applyResponseFloor, RESPONSE_FLOOR_MS } from "~/lib/restock/timing";
import { emailHash, getShopPepper } from "~/lib/crypto/secret.server";
import type { EmailProvider, EmailMessage } from "~/lib/email/provider";
import { TransientEmailError } from "~/lib/email/errors";

/*
 * Phase 12.1 Q2 — async confirmation (no outbound I/O in the public request) and
 * the deterministic response-time floor that masks the "new vs already-
 * subscribed" existence oracle. The real route needs the Shopify App Proxy
 * signature + Prisma; these test the composed mechanisms (subscribe + floor +
 * the worker-side confirm job) at the function level.
 */
const G = (n: number) => `gid://shopify/Product/${n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

async function seedUnavailable(db: TestDb, shop: string) {
  const pid = await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: G(1), title: "P", handle: "p1", vendor: "V", productType: "T", tags: [],
      status: "ACTIVE", onlineStoreUrl: "https://shop.example.com/products/p1", metafields: {},
      productCreatedAt: "2025-01-01T00:00:00Z", shopifyUpdatedAt: "2026-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: V(1), sku: "S1", price: "10", availableForSale: false });
    return id;
  });
  const cnt = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", cnt));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, cnt));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  return pid;
}

class RecordingProvider implements EmailProvider {
  sent: EmailMessage[] = [];
  constructor(private mode: "ok" | "transient" = "ok", private delayMs = 0) {}
  async send(m: EmailMessage) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.mode === "transient") throw new TransientEmailError("later", 451);
    this.sent.push(m);
    return { delivered: true, provider: "fake" as const };
  }
}

describe("Phase 12.1 Q2 — response-time floor", () => {
  it("pads to the floor and never shortens a slower response", async () => {
    const t0 = Date.now();
    await applyResponseFloor(t0, 120);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(115);
    // An already-elapsed start returns ~immediately (no negative wait).
    const t1 = Date.now() - 1000;
    const s = Date.now();
    await applyResponseFloor(t1, 120);
    expect(Date.now() - s).toBeLessThan(30);
  });
});

describe("Phase 12.1 Q2 — subscribe is constant-time-ish (no existence oracle)", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); shop = await db.resolveShop("p12async.myshopify.com"); await seedUnavailable(db, shop); });

  // Drive the REAL request-path function with a stub enqueue (no pg-boss, no
  // outbound I/O). Measure the composite wall time for each outcome.
  let enqueued = 0;
  const stubEnqueue = async () => { enqueued++; };
  async function requestLike(email: string): Promise<number> {
    const start = Date.now();
    await db.withShopExec(shop, (e) => runSubscribeRequest(e, shop, { email, productGid: G(1), consent: true }, { enqueueConfirm: stubEnqueue, startedMs: start }));
    return Date.now() - start;
  }

  it("new and already-subscribed outcomes take ~the floor and differ by < tolerance; no SMTP in the request", async () => {
    enqueued = 0;
    const newT = await requestLike("newcomer@example.com");
    expect(enqueued).toBe(1);                              // created → one async job enqueued
    await requestLike("repeat@example.com");               // create it (enqueued++)
    const existingT = await requestLike("repeat@example.com"); // now "exists" → no enqueue
    expect(enqueued).toBe(2);                              // the "exists" outcome enqueues nothing
    expect(newT).toBeGreaterThanOrEqual(RESPONSE_FLOOR_MS - 15);
    expect(existingT).toBeGreaterThanOrEqual(RESPONSE_FLOOR_MS - 15);
    // The 60–100× raw gap is gone: both are dominated by the fixed floor.
    expect(Math.abs(newT - existingT)).toBeLessThan(60);
  });
});

describe("Phase 12.1 Q2 — worker-side confirmation job", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); shop = await db.resolveShop("p12job.myshopify.com"); await seedUnavailable(db, shop); });

  const runJob = (subId: string, prov: RecordingProvider) =>
    db.withShopExec(shop, (e) => sendConfirmWithExec(e, shop, subId, { provider: prov, appUrl: "https://app.example.com" }));

  it("delivers exactly one confirmation; replaying the job sends nothing", async () => {
    const r = await db.withShopExec(shop, (e) => subscribe(e, shop, { email: "once@example.com", productGid: G(1), consent: true }));
    const prov = new RecordingProvider("ok");
    const first = await runJob(r.subscriptionId!, prov);
    expect(first.sent).toBe(true);
    expect(prov.sent.length).toBe(1);
    expect(prov.sent[0].to).toBe("once@example.com");
    // Replay → confirm_sent_at already set → nothing sent.
    const prov2 = new RecordingProvider("ok");
    const second = await runJob(r.subscriptionId!, prov2);
    expect(second.sent).toBe(false);
    expect(second.reason).toBe("already-sent");
    expect(prov2.sent.length).toBe(0);
  });

  it("never mails an already-confirmed row, nor a suppressed address", async () => {
    // confirmed: mint+confirm first, then a replayed job must not send.
    const r = await db.withShopExec(shop, (e) => subscribe(e, shop, { email: "conf@example.com", productGid: G(1), consent: true }));
    const prov0 = new RecordingProvider("ok");
    await runJob(r.subscriptionId!, prov0);
    const token = prov0.sent[0].text.match(/[?&]t=([A-Za-z0-9_-]+)/)![1];
    await db.withShopExec(shop, (e) => confirmSubscription(e, shop, r.subscriptionId!, token));
    const prov1 = new RecordingProvider("ok");
    expect((await runJob(r.subscriptionId!, prov1)).reason).toBe("not-pending");
    expect(prov1.sent.length).toBe(0);

    // suppressed: a pending row whose address is suppressed is not mailed.
    const r2 = await db.withShopExec(shop, (e) => subscribe(e, shop, { email: "supp@example.com", productGid: G(1), consent: true }));
    const pep = await db.withShopExec(shop, (e) => getShopPepper(e, shop));
    await db.withShopExec(shop, (e) => e.run(`INSERT INTO restock_suppression (shop_id,email_hash,reason) VALUES ($1::uuid,$2,'unsubscribed') ON CONFLICT DO NOTHING`, [shop, emailHash(pep, shop, "supp@example.com")]));
    const prov2 = new RecordingProvider("ok");
    expect((await runJob(r2.subscriptionId!, prov2)).reason).toBe("suppressed");
    expect(prov2.sent.length).toBe(0);
  });

  it("a transient send failure leaves the row retryable (confirm_sent_at stays null)", async () => {
    const r = await db.withShopExec(shop, (e) => subscribe(e, shop, { email: "flake@example.com", productGid: G(1), consent: true }));
    await expect(runJob(r.subscriptionId!, new RecordingProvider("transient"))).rejects.toBeInstanceOf(TransientEmailError);
    const sentAt = await db.withShopExec(shop, async (e) => (await e.rows<{ c: string | null }>("SELECT confirm_sent_at c FROM back_in_stock_subscription WHERE id=$1::uuid", [r.subscriptionId]))[0].c);
    expect(sentAt).toBeNull();
    // a later run (provider recovered) delivers exactly one.
    const prov = new RecordingProvider("ok");
    expect((await runJob(r.subscriptionId!, prov)).sent).toBe(true);
    expect(prov.sent.length).toBe(1);
  });

  it("a slow provider delays only the job, not the subscribe request path", async () => {
    const r = await db.withShopExec(shop, (e) => subscribe(e, shop, { email: "slow@example.com", productGid: G(1), consent: true }));
    // The request path (subscribe) already returned above with NO provider call.
    // The delay lives entirely in the worker job:
    const start = Date.now();
    await runJob(r.subscriptionId!, new RecordingProvider("ok", 250));
    expect(Date.now() - start).toBeGreaterThanOrEqual(240); // the delay is here, off the request path
  });
});
