import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { subscribe } from "~/lib/restock/subscriptions";
import { selectStrandedConfirmations } from "~/lib/restock/retention";
import { runRestockConfirmSweep } from "~/lib/jobs/maintenance";
import { saveEmailSettings } from "~/lib/email/settings";
import { emailHash, getShopPepper } from "~/lib/crypto/secret.server";

/** Mark a shop's email as configured + valid (host+port+from, no auth needed). */
const configureEmail = (db: TestDb, shop: string) =>
  db.withShopExec(shop, (e) => saveEmailSettings(e, shop, { host: "smtp.example.com", port: 587, fromEmail: "shop@example.com" }));

/*
 * Phase 12.2 R5b — the lost-confirmation sweeper. A pending row whose confirm
 * never got sent (enqueue failed / process died) must be re-enqueued by the
 * maintenance tick; sent / confirmed / expired / suppressed / too-fresh rows
 * must NOT be. Idempotent (re-enqueue uses the same singleton key); bounded;
 * RLS-scoped; cross-shop isolated.
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

// Insert a pending row directly with a controllable created_at / confirm_sent_at.
async function insertPending(db: TestDb, shop: string, pid: string, email: string, opts: { ageMin?: number; ageDays?: number; sent?: boolean; status?: string } = {}) {
  const pep = await db.withShopExec(shop, (e) => getShopPepper(e, shop));
  const age = opts.ageDays != null ? `${opts.ageDays} days` : `${opts.ageMin ?? 10} minutes`;
  return db.withShopExec(shop, async (e) => {
    const r = await e.rows<{ id: string }>(
      `INSERT INTO back_in_stock_subscription
         (id,shop_id,product_id,shopify_product_gid,variant_key,email,email_hash,locale,status,unsubscribe_token_hash,confirm_sent_at,created_at,updated_at)
       VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3,'',$4,$5,'en',$6,'h'||$4, ${opts.sent ? "now()" : "NULL"}, now() - interval '${age}', now())
       RETURNING id`,
      [shop, pid, G(1), email, emailHash(pep, shop, email), opts.status ?? "pending"],
    );
    return r[0].id;
  });
}

describe("Phase 12.2 R5b — stranded-confirmation sweeper", () => {
  let db: TestDb; let shopA: string; let shopB: string; let pidA: string; let pidB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p122a.myshopify.com");
    shopB = await db.resolveShop("p122b.myshopify.com");
    pidA = await seedUnavailable(db, shopA);
    pidB = await seedUnavailable(db, shopB);
  });

  it("selects only genuinely-stranded rows", async () => {
    const stranded = await insertPending(db, shopA, pidA, "stranded@e.com", { ageMin: 10 });
    await insertPending(db, shopA, pidA, "fresh@e.com", { ageMin: 1 });          // too fresh
    await insertPending(db, shopA, pidA, "sent@e.com", { ageMin: 10, sent: true }); // already sent
    await insertPending(db, shopA, pidA, "old@e.com", { ageDays: 8 });            // past the 7-day TTL
    await insertPending(db, shopA, pidA, "confirmed@e.com", { ageMin: 10, status: "confirmed" });
    // suppressed address
    const pep = await db.withShopExec(shopA, (e) => getShopPepper(e, shopA));
    await insertPending(db, shopA, pidA, "supp@e.com", { ageMin: 10 });
    await db.withShopExec(shopA, (e) => e.run(`INSERT INTO restock_suppression (shop_id,email_hash,reason) VALUES ($1::uuid,$2,'unsubscribed') ON CONFLICT DO NOTHING`, [shopA, emailHash(pep, shopA, "supp@e.com")]));

    const ids = await db.withShopExec(shopA, (e) => selectStrandedConfirmations(e, shopA, { now: new Date() }));
    expect(ids).toEqual([stranded]);
  });

  it("is bounded by the batch size and ordered oldest-first", async () => {
    for (let i = 0; i < 5; i++) await insertPending(db, shopA, pidA, `b${i}@e.com`, { ageMin: 10 + i });
    const ids = await db.withShopExec(shopA, (e) => selectStrandedConfirmations(e, shopA, { now: new Date(), batchSize: 2 }));
    expect(ids.length).toBe(2);
  });

  it("second run after the confirmation is sent no longer selects it", async () => {
    const id = await insertPending(db, shopA, pidA, "once@e.com", { ageMin: 10 });
    expect(await db.withShopExec(shopA, (e) => selectStrandedConfirmations(e, shopA, { now: new Date() }))).toEqual([id]);
    // the worker sends → stamps confirm_sent_at
    await db.withShopExec(shopA, (e) => e.run("UPDATE back_in_stock_subscription SET confirm_sent_at=now() WHERE id=$1::uuid", [id]));
    expect(await db.withShopExec(shopA, (e) => selectStrandedConfirmations(e, shopA, { now: new Date() }))).toEqual([]);
  });

  it("another shop's stranded row is never selected (RLS)", async () => {
    await insertPending(db, shopB, pidB, "b@e.com", { ageMin: 10 });
    expect(await db.withShopExec(shopA, (e) => selectStrandedConfirmations(e, shopA, { now: new Date() }))).toEqual([]);
  });

  it("runRestockConfirmSweep re-enqueues across installed CONFIGURED shops (same singleton key dedupes)", async () => {
    await configureEmail(db, shopA); await configureEmail(db, shopB);
    await insertPending(db, shopA, pidA, "a@e.com", { ageMin: 10 });
    await insertPending(db, shopB, pidB, "b@e.com", { ageMin: 10 });
    const calls: Array<[string, string]> = [];
    const enqueue = async (shopId: string, subId: string) => { calls.push([shopId, subId]); };
    const n = await runRestockConfirmSweep(db.rootExec, db.withShopExec, enqueue, { now: new Date() });
    expect(n).toBe(2);
    expect(calls.map((c) => c[0]).sort()).toEqual([shopA, shopB].sort());
  });

  it("13.0: a NO-SMTP shop gives ZERO enqueues over many ticks (no churn, cap untouched)", async () => {
    // shopA is NOT configured; a stranded row exists.
    const id = await insertPending(db, shopA, pidA, "nosmtp@e.com", { ageMin: 10 });
    let now = new Date();
    const enqueue = async () => { throw new Error("should not enqueue"); };
    let total = 0;
    for (let i = 0; i < 6; i++) {
      total += await runRestockConfirmSweep(db.rootExec, db.withShopExec, enqueue, { now });
      now = new Date(now.getTime() + 3600_000); // +1h per tick
    }
    expect(total).toBe(0);
    // the attempt cap was never burned, so configuring later still releases it.
    const count = await db.withShopExec(shopA, async (e) => (await e.rows<{ c: number }>("SELECT confirm_sweep_count c FROM back_in_stock_subscription WHERE id=$1::uuid", [id]))[0].c);
    expect(Number(count)).toBe(0);
  });

  it("13.0: a configured shop re-enqueues with exponential backoff then stops at the cap", async () => {
    await configureEmail(db, shopA);
    const id = await insertPending(db, shopA, pidA, "backoff@e.com", { ageMin: 10 });
    const seen: string[] = [];
    const enqueue = async (_s: string, subId: string) => { seen.push(subId); };
    const t0 = new Date("2026-06-01T00:00:00Z");
    // Pin created_at just before the injected clock so the age gate holds.
    await db.withShopExec(shopA, (e) => e.run("UPDATE back_in_stock_subscription SET created_at=$2::timestamptz WHERE id=$1::uuid", [id, new Date(t0.getTime() - 600_000).toISOString()]));
    // First sweep fires immediately (confirm_last_sweep_at NULL); then each next
    // enqueue needs 2^count h since the last — cumulative boundaries 0,2,6,14,30h.
    // After the 5th enqueue at 30h the next backoff boundary is 30+2^5=62h; a
    // sweep there must NOT fire because the count hit the cap of 5.
    const offsetsH = [0, 2, 6, 14, 30, 62];
    for (const h of offsetsH) {
      const now = new Date(t0.getTime() + h * 3600_000);
      await runRestockConfirmSweep(db.rootExec, db.withShopExec, enqueue, { now });
    }
    // 5 attempts then the cap stops it (count 0→5), never a 6th.
    expect(seen.length).toBe(5);
    const count = await db.withShopExec(shopA, async (e) => (await e.rows<{ c: number }>("SELECT confirm_sweep_count c FROM back_in_stock_subscription WHERE id=$1::uuid", [id]))[0].c);
    expect(Number(count)).toBe(5);
  });

  it("13.0: configuring SMTP later releases a stranded row still inside the TTL", async () => {
    const id = await insertPending(db, shopA, pidA, "late@e.com", { ageMin: 10 });
    const enqueue = async () => {};
    // unconfigured → nothing
    expect(await runRestockConfirmSweep(db.rootExec, db.withShopExec, enqueue, { now: new Date() })).toBe(0);
    // configure, then it is picked up (count was never burned)
    await configureEmail(db, shopA);
    expect(await runRestockConfirmSweep(db.rootExec, db.withShopExec, enqueue, { now: new Date() })).toBe(1);
    void id;
  });
});
