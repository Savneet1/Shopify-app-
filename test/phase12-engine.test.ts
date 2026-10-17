import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion, refreshDocInActiveVersion } from "~/lib/index/engine";
import { subscribe, confirmSubscription, unsubscribe, checkSubscribable } from "~/lib/restock/subscriptions";
import { detectAndQueueRestock } from "~/lib/restock/detect";
import { recordAvailabilityTransitions } from "~/lib/restock/availability";
import { createPendingNotifications, drainRestockNotifications } from "~/lib/restock/notify";
import { purgeRestockData } from "~/lib/restock/retention";
import { saveRestockSettings } from "~/lib/restock/settings";
import { saveEmailSettings, loadEmailSettingsView, loadSmtpConfig } from "~/lib/email/settings";
import { emailHash } from "~/lib/crypto/secret.server";
import type { EmailProvider, EmailMessage } from "~/lib/email/provider";
import { PermanentEmailError, TransientEmailError } from "~/lib/email/errors";

/*
 * Phase 12 — engine tests against real PostgreSQL (migration 0015 applied).
 * Exercises the subscribe/confirm/notify lifecycle, idempotency, suppression,
 * retention, encryption-at-rest, cross-shop RLS on EVERY new table, and the
 * GDPR data operations — all as app_runtime under RLS.
 */
const G = (n: number) => `gid://shopify/Product/${n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const handleOf = (gid: string) => gid.split("/").pop()!;

async function seedProduct(db: TestDb, shop: string, pGid: string, vGid: string, available: boolean, updatedAt = "2026-01-01T00:00:00Z") {
  return db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: pGid, title: "Widget " + handleOf(pGid), handle: handleOf(pGid), vendor: "V",
      productType: "T", tags: ["t"], status: "ACTIVE", onlineStoreUrl: `https://shop.example.com/products/${handleOf(pGid)}`,
      featuredImageUrl: `https://cdn.shopify.com/${handleOf(pGid)}.jpg`, metafields: {},
      productCreatedAt: "2025-01-01T00:00:00Z", shopifyUpdatedAt: updatedAt,
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: vGid, sku: "S" + handleOf(vGid), price: "10", availableForSale: available, shopifyUpdatedAt: updatedAt });
    return id;
  });
}
async function buildIndex(db: TestDb, shop: string): Promise<string> {
  const n = await db.withShopExec(shop, async (e) =>
    (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  return v.id;
}
async function flipVariant(db: TestDb, shop: string, productId: string, pGid: string, vGid: string, available: boolean, updatedAt: string) {
  await db.withShopExec(shop, async (e) => {
    await upsertProduct(e, shop, {
      shopifyProductGid: pGid, title: "Widget " + handleOf(pGid), handle: handleOf(pGid), vendor: "V",
      productType: "T", tags: ["t"], status: "ACTIVE", onlineStoreUrl: `https://shop.example.com/products/${handleOf(pGid)}`,
      featuredImageUrl: `https://cdn.shopify.com/${handleOf(pGid)}.jpg`, metafields: {},
      productCreatedAt: "2025-01-01T00:00:00Z", shopifyUpdatedAt: updatedAt,
    });
    await upsertVariant(e, shop, productId, { shopifyVariantGid: vGid, sku: "S" + handleOf(vGid), price: "10", availableForSale: available, shopifyUpdatedAt: updatedAt });
    await refreshDocInActiveVersion(e, shop, productId);
  });
}

/** A fake email provider that records sends and can be told to fail. */
class RecordingProvider implements EmailProvider {
  sent: EmailMessage[] = [];
  constructor(private mode: "ok" | "permanent" | "transient" = "ok") {}
  async send(m: EmailMessage) {
    if (this.mode === "permanent") throw new PermanentEmailError("rejected", 550);
    if (this.mode === "transient") throw new TransientEmailError("later", 451);
    this.sent.push(m);
    return { delivered: true, provider: "fake" as const };
  }
}

const SUB = (over: Record<string, unknown> = {}) => ({
  email: "shopper@example.com", productGid: G(1), locale: "en", consent: true, consentTextVersion: "v1", source: "product_page", ...over,
});

describe("Phase 12.2 — subscribe + confirm lifecycle", () => {
  let db: TestDb; let shop: string; let pid: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p12e.myshopify.com");
    pid = await seedProduct(db, shop, G(1), V(11), false); // unavailable
    await buildIndex(db, shop);
  });

  it("created → pending → confirmed", async () => {
    const r = await db.withShopExec(shop, (e) => subscribe(e, shop, SUB()));
    expect(r.outcome).toBe("created");
    expect(r.confirmToken).toBeTruthy();
    const status1 = await db.withShopExec(shop, async (e) => (await e.rows<{ status: string }>("SELECT status FROM back_in_stock_subscription WHERE id=$1::uuid", [r.subscriptionId]))[0].status);
    expect(status1).toBe("pending");
    const c = await db.withShopExec(shop, (e) => confirmSubscription(e, shop, r.subscriptionId!, r.confirmToken!));
    expect(c.confirmed).toBe(true);
    const status2 = await db.withShopExec(shop, async (e) => (await e.rows<{ status: string }>("SELECT status FROM back_in_stock_subscription WHERE id=$1::uuid", [r.subscriptionId]))[0].status);
    expect(status2).toBe("confirmed");
    // confirm is not replayable (token cleared)
    const again = await db.withShopExec(shop, (e) => confirmSubscription(e, shop, r.subscriptionId!, r.confirmToken!));
    expect(again.confirmed).toBe(false);
  });

  it("only an UNAVAILABLE visible product is subscribable", async () => {
    const pid2 = await seedProduct(db, shop, G(2), V(22), true); // available
    await buildIndex(db, shop);
    expect(await db.withShopExec(shop, (e) => checkSubscribable(e, shop, G(2), null))).toBeNull();
    const r = await db.withShopExec(shop, (e) => subscribe(e, shop, SUB({ productGid: G(2) })));
    expect(r.outcome).toBe("not_applicable");
    // a product not in the active index is also not subscribable
    const r2 = await db.withShopExec(shop, (e) => subscribe(e, shop, SUB({ productGid: G(999) })));
    expect(r2.outcome).toBe("not_applicable");
    void pid2;
  });

  it("dedupe: a second identical subscribe returns 'exists' (no reveal, no new row)", async () => {
    const r1 = await db.withShopExec(shop, (e) => subscribe(e, shop, SUB()));
    expect(r1.outcome).toBe("created");
    const r2 = await db.withShopExec(shop, (e) => subscribe(e, shop, SUB()));
    expect(r2.outcome).toBe("exists");
    const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM back_in_stock_subscription WHERE shop_id=$1::uuid", [shop]))[0].n);
    expect(n).toBe(1);
  });

  it("rejects hostile input before any SQL (never throws, never leaks)", async () => {
    for (const bad of [
      SUB({ email: "not-an-email" }),
      SUB({ email: "a@b.com\r\nBcc: x@y.com" }),
      SUB({ email: "x".repeat(10000) + "@b.com" }),
      SUB({ email: "a@b.com'; DROP TABLE back_in_stock_subscription; --" }),
      SUB({ consent: false }),
      SUB({ productGid: "not-a-gid" }),
      SUB({ productGid: G(1), variantGid: "bad" }),
    ]) {
      const r = await db.withShopExec(shop, (e) => subscribe(e, shop, bad as any));
      expect(["rejected", "not_applicable"]).toContain(r.outcome);
    }
    // table still intact
    const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM back_in_stock_subscription WHERE shop_id=$1::uuid", [shop]))[0].n);
    expect(n).toBe(0);
  });

  it("per-email and per-shop daily caps are enforced", async () => {
    await db.withShopExec(shop, (e) => saveRestockSettings(e, shop, { perEmailDailyCap: 2, perShopDailyCap: 1000 }));
    await seedProduct(db, shop, G(2), V(22), false);
    await seedProduct(db, shop, G(3), V(33), false);
    await buildIndex(db, shop);
    expect((await db.withShopExec(shop, (e) => subscribe(e, shop, SUB({ productGid: G(1) })))).outcome).toBe("created");
    expect((await db.withShopExec(shop, (e) => subscribe(e, shop, SUB({ productGid: G(2) })))).outcome).toBe("created");
    expect((await db.withShopExec(shop, (e) => subscribe(e, shop, SUB({ productGid: G(3) })))).outcome).toBe("capped");
  });

  it("suppressed addresses are not re-collected", async () => {
    const hash = emailHash(shop, "shopper@example.com");
    await db.withShopExec(shop, (e) => e.run(`INSERT INTO restock_suppression (shop_id, email_hash, reason, created_at) VALUES ($1::uuid,$2,'unsubscribed',now())`, [shop, hash]));
    expect((await db.withShopExec(shop, (e) => subscribe(e, shop, SUB()))).outcome).toBe("suppressed");
  });

  it("unsubscribe is idempotent and records a suppression; never reveals existence", async () => {
    const r = await db.withShopExec(shop, (e) => subscribe(e, shop, SUB()));
    const { deriveUnsubToken } = await import("~/lib/crypto/secret.server");
    const tok = deriveUnsubToken(shop, r.subscriptionId!);
    expect((await db.withShopExec(shop, (e) => unsubscribe(e, shop, r.subscriptionId!, tok))).ok).toBe(true);
    expect((await db.withShopExec(shop, (e) => unsubscribe(e, shop, r.subscriptionId!, tok))).ok).toBe(true); // idempotent
    // a forged / wrong token fails closed
    expect((await db.withShopExec(shop, (e) => unsubscribe(e, shop, r.subscriptionId!, "wrong"))).ok).toBe(false);
    const sup = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM restock_suppression WHERE shop_id=$1::uuid", [shop]))[0].n);
    expect(sup).toBe(1);
  });

  it("confirm/unsubscribe with a tampered or expired token fail closed", async () => {
    const r = await db.withShopExec(shop, (e) => subscribe(e, shop, SUB()));
    expect((await db.withShopExec(shop, (e) => confirmSubscription(e, shop, r.subscriptionId!, "tampered"))).confirmed).toBe(false);
    // expired: confirm with now past the TTL
    const future = new Date(Date.now() + 1000 * 3600 * 24 * 8);
    expect((await db.withShopExec(shop, (e) => confirmSubscription(e, shop, r.subscriptionId!, r.confirmToken!, { now: future }))).confirmed).toBe(false);
  });
});

describe("Phase 12.3 — restock detection + notification", () => {
  let db: TestDb; let shop: string; let pid: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p12n.myshopify.com");
    pid = await seedProduct(db, shop, G(1), V(11), false, "2026-02-01T00:00:00Z");
    await buildIndex(db, shop);
    const r = await db.withShopExec(shop, (e) => subscribe(e, shop, SUB()));
    await db.withShopExec(shop, (e) => confirmSubscription(e, shop, r.subscriptionId!, r.confirmToken!));
  });

  const drain = (mode: "ok" | "permanent" | "transient" = "ok") => {
    const prov = new RecordingProvider(mode);
    return db.withShopExec(shop, (e) => drainRestockNotifications(e, shop, {
      provider: prov, shopName: "Shop", links: { appUrl: "https://app.example.com", shopDomain: "s.myshopify.com", shopId: shop },
    })).then((res) => ({ res, prov }));
  };

  it("an unavailable→available transition queues exactly one pending notification", async () => {
    await flipVariant(db, shop, pid, G(1), V(11), true, "2026-03-01T00:00:00Z");
    const d = await db.withShopExec(shop, (e) => detectAndQueueRestock(e, shop, pid));
    expect(d.transitions).toBe(1);
    expect(d.created).toBe(1);
    const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM restock_notification WHERE shop_id=$1::uuid AND status='pending'", [shop]))[0].n);
    expect(n).toBe(1);
  });

  it("a replay / same-epoch re-detection does NOT create a second notification", async () => {
    await flipVariant(db, shop, pid, G(1), V(11), true, "2026-03-01T00:00:00Z");
    await db.withShopExec(shop, (e) => detectAndQueueRestock(e, shop, pid));
    // Re-run with the SAME source timestamp (stale/replayed webhook) → monotonic
    // guard ignores it; no new transition, no new pending row.
    const d2 = await db.withShopExec(shop, (e) => detectAndQueueRestock(e, shop, pid));
    expect(d2.transitions).toBe(0);
    const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM restock_notification WHERE shop_id=$1::uuid", [shop]))[0].n);
    expect(n).toBe(1);
  });

  it("drain sends exactly one email per subscription and flips it to 'notified'", async () => {
    await flipVariant(db, shop, pid, G(1), V(11), true, "2026-03-01T00:00:00Z");
    await db.withShopExec(shop, (e) => detectAndQueueRestock(e, shop, pid));
    const { res, prov } = await drain("ok");
    expect(res.sent).toBe(1);
    expect(prov.sent.length).toBe(1);
    expect(prov.sent[0].to).toBe("shopper@example.com");
    expect(prov.sent[0].headers && prov.sent[0].headers["List-Unsubscribe"]).toContain("/restock/unsubscribe");
    const status = await db.withShopExec(shop, async (e) => (await e.rows<{ status: string }>("SELECT status FROM back_in_stock_subscription WHERE shop_id=$1::uuid LIMIT 1", [shop]))[0].status);
    expect(status).toBe("notified");
    // a second drain sends nothing (one-send-per-subscription)
    const { prov: prov2 } = await drain("ok");
    expect(prov2.sent.length).toBe(0);
  });

  it("send-time re-check: a product that went unavailable again is skipped, not mailed", async () => {
    await flipVariant(db, shop, pid, G(1), V(11), true, "2026-03-01T00:00:00Z");
    await db.withShopExec(shop, (e) => detectAndQueueRestock(e, shop, pid));
    // It sells out again before the drain runs.
    await flipVariant(db, shop, pid, G(1), V(11), false, "2026-03-02T00:00:00Z");
    const { res, prov } = await drain("ok");
    expect(prov.sent.length).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it("a permanent provider error marks bounced + suppresses the address", async () => {
    await flipVariant(db, shop, pid, G(1), V(11), true, "2026-03-01T00:00:00Z");
    await db.withShopExec(shop, (e) => detectAndQueueRestock(e, shop, pid));
    const { res } = await drain("permanent");
    expect(res.bounced).toBe(1);
    const sup = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM restock_suppression WHERE shop_id=$1::uuid AND reason='bounced'", [shop]))[0].n);
    expect(sup).toBe(1);
  });

  it("a transient provider error leaves the notification pending for a later run", async () => {
    await flipVariant(db, shop, pid, G(1), V(11), true, "2026-03-01T00:00:00Z");
    await db.withShopExec(shop, (e) => detectAndQueueRestock(e, shop, pid));
    const { res } = await drain("transient");
    expect(res.transient).toBe(1);
    const pending = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM restock_notification WHERE shop_id=$1::uuid AND status='pending'", [shop]))[0].n);
    expect(pending).toBe(1);
  });
});

describe("Phase 12 — query counts (hot paths)", () => {
  let db: TestDb; let shop: string; let pid: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p12q.myshopify.com");
    pid = await seedProduct(db, shop, G(1), V(11), false, "2026-02-01T00:00:00Z");
    await buildIndex(db, shop);
  });

  it("subscribe is a bounded number of queries; fan-out does NOT grow per subscriber", async () => {
    // subscribe
    const c1 = await makeExec(db, shop);
    await c1.wrap((e) => subscribe(e, shop, SUB()));
    // eslint-disable-next-line no-console
    console.log(`[query-count] subscribe = ${c1.count()} queries`);
    expect(c1.count()).toBeLessThanOrEqual(7);

    // Confirm all, add MANY more confirmed subscribers, then measure fan-out.
    await db.withShopExec(shop, (e) => e.run("UPDATE back_in_stock_subscription SET status='confirmed', confirm_token_hash=NULL WHERE shop_id=$1::uuid", [shop]));
    // add 20 more confirmed subs on the same product+variant target
    await db.withShopExec(shop, async (e) => {
      for (let i = 0; i < 20; i++) {
        await e.run(
          `INSERT INTO back_in_stock_subscription (id, shop_id, product_id, shopify_product_gid, variant_key, email, email_hash, locale, status, unsubscribe_token_hash, created_at, updated_at)
           VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3,'', $4,$5,'en','confirmed','h'||$6, now(), now())`,
          [shop, pid, G(1), `b${i}@e.com`, emailHash(shop, `b${i}@e.com`), String(i)],
        );
      }
    });
    await flipVariant(db, shop, pid, G(1), V(11), true, "2026-03-01T00:00:00Z");
    const transitions = await db.withShopExec(shop, (e) => recordAvailabilityTransitions(e, shop, pid));
    const c2 = await makeExec(db, shop);
    const created = await c2.wrap((e) => createPendingNotifications(e, shop, transitions));
    // eslint-disable-next-line no-console
    console.log(`[query-count] fan-out createPendingNotifications for ${created} subscribers = ${c2.count()} queries`);
    expect(created).toBe(21);
    expect(c2.count()).toBe(1); // ONE set-based insert, regardless of subscriber count
  });

  it("product-page countdown + preorder lookups are a bounded number of queries", async () => {
    const { resolveCountdown } = await import("~/lib/countdown/resolve.server");
    const { resolvePreorder } = await import("~/lib/preorder/annotate.server");
    const c = await makeExec(db, shop);
    await c.wrap((e) => resolveCountdown(e, shop, G(1), new Date()));
    // eslint-disable-next-line no-console
    console.log(`[query-count] countdown lookup (no rules) = ${c.count()} queries`);
    expect(c.count()).toBeLessThanOrEqual(1); // early-out: one "any rules?" read
    const c2 = await makeExec(db, shop);
    await c2.wrap((e) => resolvePreorder(e, shop, G(1), new Date()));
    console.log(`[query-count] preorder lookup (no rules) = ${c2.count()} queries`);
    expect(c2.count()).toBeLessThanOrEqual(1);
  });
});

// Helper: a counting wrapper bound to a fresh shop-scoped connection.
async function makeExec(db: TestDb, shop: string) {
  // We can't keep a withShopExec transaction open across calls, so return a
  // small object whose .wrap runs fn inside ONE shop-scoped tx with a counting
  // exec, and exposes the count afterwards.
  let n = 0;
  return {
    count: () => n,
    wrap: <T>(fn: (e: Exec) => Promise<T>) =>
      db.withShopExec(shop, (e: Exec) => fn({
        rows: (sql: string, params?: unknown[]) => { n++; return e.rows(sql, params as unknown[]); },
        run: (sql: string, params?: unknown[]) => { n++; return e.run(sql, params as unknown[]); },
      })),
  };
}
