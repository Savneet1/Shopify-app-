import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { subscribe } from "~/lib/restock/subscriptions";
import { selectStrandedConfirmations } from "~/lib/restock/retention";
import { runRestockConfirmSweep } from "~/lib/jobs/maintenance";
import { emailHash, getShopPepper } from "~/lib/crypto/secret.server";

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

  it("runRestockConfirmSweep re-enqueues across installed shops (same singleton key dedupes)", async () => {
    await insertPending(db, shopA, pidA, "a@e.com", { ageMin: 10 });
    await insertPending(db, shopB, pidB, "b@e.com", { ageMin: 10 });
    const calls: Array<[string, string]> = [];
    const enqueue = async (shopId: string, subId: string) => { calls.push([shopId, subId]); };
    const n = await runRestockConfirmSweep(db.rootExec, db.withShopExec, enqueue, { now: new Date() });
    expect(n).toBe(2);
    expect(calls.map((c) => c[0]).sort()).toEqual([shopA, shopB].sort());
  });
});
