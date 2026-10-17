import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { subscribe, confirmSubscription } from "~/lib/restock/subscriptions";
import { saveEmailSettings, loadEmailSettingsView, loadSmtpConfig } from "~/lib/email/settings";
import { saveRestockSettings } from "~/lib/restock/settings";
import { createPreorderRule } from "~/lib/preorder/rules";
import { createCountdownRule } from "~/lib/countdown/rules";
import { deleteAllForEmail } from "~/lib/restock/admin";
import { purgeRestockData } from "~/lib/restock/retention";
import { emailHash } from "~/lib/crypto/secret.server";

/*
 * Phase 12.7 — privacy, RLS, encryption-at-rest, retention, and the GDPR data
 * operations. Every new table is a tenant table; shopper emails are only ever
 * stored on back_in_stock_subscription (plaintext, needed to send) alongside a
 * keyed hash, and never copied into the notification ledger, jobs or analytics.
 */
const G = (n: number) => `gid://shopify/Product/${n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

async function seedUnavailable(db: TestDb, shop: string, n: number) {
  const pid = await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: G(n), title: "P" + n, handle: "p" + n, vendor: "V", productType: "T", tags: [],
      status: "ACTIVE", onlineStoreUrl: `https://shop.example.com/products/p${n}`, metafields: {},
      productCreatedAt: "2025-01-01T00:00:00Z", shopifyUpdatedAt: "2026-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: V(n), sku: "S" + n, price: "10", availableForSale: false });
    return id;
  });
  const cnt = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", cnt));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, cnt));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  return pid;
}

const NEW_TABLES = [
  "email_setting", "restock_setting", "back_in_stock_subscription",
  "restock_availability", "restock_notification", "restock_suppression",
  "preorder_rule", "countdown_rule",
];

describe("Phase 12.7 — RLS + cross-shop isolation on every new table", () => {
  let db: TestDb; let shopA: string; let shopB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p12pa.myshopify.com");
    shopB = await db.resolveShop("p12pb.myshopify.com");
  });

  it("all eight tables have RLS ENABLED + FORCED", async () => {
    const { rows } = await db.runtimePool.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity rls, c.relforcerowsecurity forced
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname = ANY($1)`, [NEW_TABLES],
    );
    expect(rows.length).toBe(8);
    for (const r of rows) { expect(r.rls, r.relname).toBe(true); expect(r.forced, r.relname).toBe(true); }
  });

  it("rows written by shop A are invisible to shop B (every table)", async () => {
    const pidA = await seedUnavailable(db, shopA, 1);
    // populate each table for shop A
    await db.withShopExec(shopA, (e) => saveEmailSettings(e, shopA, { host: "smtp.x", port: 587, fromEmail: "s@x.com" }));
    await db.withShopExec(shopA, (e) => saveRestockSettings(e, shopA, { perEmailDailyCap: 9 }));
    await db.withShopExec(shopA, (e) => createPreorderRule(e, shopA, { matchType: "tag", matchValue: "pre" }));
    await db.withShopExec(shopA, (e) => createCountdownRule(e, shopA, { scope: "global", endsAt: "2027-01-01T00:00:00Z" }));
    const sub = await db.withShopExec(shopA, (e) => subscribe(e, shopA, { email: "x@y.com", productGid: G(1), consent: true }));
    await db.withShopExec(shopA, (e) => confirmSubscription(e, shopA, sub.subscriptionId!, sub.confirmToken!));
    await db.withShopExec(shopA, (e) => e.run(`INSERT INTO restock_availability (shop_id,product_id,variant_key,available,epoch) VALUES ($1::uuid,$2::uuid,'',false,0)`, [shopA, pidA]));
    await db.withShopExec(shopA, (e) => e.run(`INSERT INTO restock_notification (shop_id,subscription_id,epoch,status) VALUES ($1::uuid,$2::uuid,1,'pending')`, [shopA, sub.subscriptionId]));
    await db.withShopExec(shopA, (e) => e.run(`INSERT INTO restock_suppression (shop_id,email_hash,reason) VALUES ($1::uuid,$2,'unsubscribed')`, [shopA, emailHash(shopA, "z@z.com")]));

    for (const t of NEW_TABLES) {
      const a = await db.withShopExec(shopA, async (e) => (await e.rows<{ n: number }>(`SELECT count(*)::int n FROM ${t}`, []))[0].n);
      const b = await db.withShopExec(shopB, async (e) => (await e.rows<{ n: number }>(`SELECT count(*)::int n FROM ${t}`, []))[0].n);
      expect(a, `${t} visible to A`).toBeGreaterThanOrEqual(1);
      expect(b, `${t} leaked to B`).toBe(0);
    }
  });

  it("WITH CHECK blocks inserting another shop's row (preorder_rule)", async () => {
    await expect(
      db.withShopExec(shopB, (e) => e.run(
        `INSERT INTO preorder_rule (shop_id, match_type, match_value) VALUES ($1::uuid,'tag','x')`, [shopA],
      )),
    ).rejects.toThrow();
  });
});

describe("Phase 12.1 — SMTP credentials are encrypted at rest + never returned", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); shop = await db.resolveShop("p12enc.myshopify.com"); });

  it("the stored password is ciphertext; the view exposes only status + last 2 chars", async () => {
    await db.withShopExec(shop, (e) => saveEmailSettings(e, shop, {
      host: "smtp.example.com", port: 587, security: "starttls", username: "apikey",
      password: "super-secret-pw", fromEmail: "shop@example.com",
    }));
    // raw column is ciphertext (never the plaintext)
    const cipher = await db.withShopExec(shop, async (e) => (await e.rows<{ c: string }>("SELECT password_cipher c FROM email_setting WHERE shop_id=$1::uuid", [shop]))[0].c);
    expect(cipher).toBeTruthy();
    expect(cipher).not.toContain("super-secret-pw");
    // the safe view carries NO password, only status + last-2
    const view = await db.withShopExec(shop, (e) => loadEmailSettingsView(e, shop));
    expect((view as unknown as Record<string, unknown>).password).toBeUndefined();
    expect(view.passwordSet).toBe(true);
    expect(view.passwordLast2).toBe("pw");
    expect(view.configured).toBe(true);
    // the factory-only loader decrypts it
    const cfg = await db.withShopExec(shop, (e) => loadSmtpConfig(e, shop));
    expect(cfg!.password).toBe("super-secret-pw");
  });

  it("refuses to save a password when no encryption key is configured (nothing written)", async () => {
    const saved = process.env.EMAIL_ENCRYPTION_KEY;
    try {
      delete process.env.EMAIL_ENCRYPTION_KEY;
      await expect(db.withShopExec(shop, (e) => saveEmailSettings(e, shop, { host: "h", port: 25, password: "p", fromEmail: "s@e.com" }))).rejects.toThrow();
      const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM email_setting WHERE shop_id=$1::uuid", [shop]))[0].n);
      expect(n).toBe(0);
    } finally { process.env.EMAIL_ENCRYPTION_KEY = saved; }
  });
});

describe("Phase 12.7 — no email text leaks into the ledger / jobs / analytics", () => {
  let db: TestDb;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  it("a plaintext 'email' column exists ONLY on back_in_stock_subscription; the ledger has none", async () => {
    // Any column whose name mentions "email" (plaintext or hash), per table.
    // Precisely the SHOPPER-email columns: the plaintext address ('email') and
    // the keyed lookup hash ('email_hash'). (Merchant-own send addresses like
    // from_email/reply_to and unrelated names like per_email_daily_cap are not
    // shopper PII and are excluded by the exact match.)
    const { rows } = await db.runtimePool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name = ANY($1) AND column_name IN ('email','email_hash')
       ORDER BY table_name, column_name`, [NEW_TABLES],
    );
    // The plaintext address lives on exactly one table (needed to send).
    const plaintext = rows.filter((r) => r.column_name === "email").map((r) => r.table_name);
    expect(plaintext).toEqual(["back_in_stock_subscription"]);
    // The notification ledger carries NEITHER (subscription id only).
    expect(rows.find((r) => r.table_name === "restock_notification")).toBeUndefined();
  });
});

describe("Phase 12.7 — retention purge (injected clock, bounded batches)", () => {
  let db: TestDb; let shop: string; let pid: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p12ret.myshopify.com");
    pid = await seedUnavailable(db, shop, 1);
  });

  it("purges unconfirmed rows older than 7 days; keeps fresh ones", async () => {
    // one fresh pending + two stale pending (created 10 days ago)
    await db.withShopExec(shop, (e) => subscribe(e, shop, { email: "fresh@e.com", productGid: G(1), consent: true }));
    await db.withShopExec(shop, async (e) => {
      for (const who of ["old1@e.com", "old2@e.com"]) {
        await e.run(
          `INSERT INTO back_in_stock_subscription (id,shop_id,product_id,shopify_product_gid,variant_key,email,email_hash,locale,status,unsubscribe_token_hash,created_at,updated_at)
           VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3,'',$4,$5,'en','pending','h'||$4, now() - interval '10 days', now() - interval '10 days')`,
          [shop, pid, G(1), who, emailHash(shop, who)],
        );
      }
    });
    const now = new Date();
    const r = await db.withShopExec(shop, (e) => purgeRestockData(e, shop, { now }));
    expect(r.unconfirmedPurged).toBe(2);
    const left = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM back_in_stock_subscription WHERE shop_id=$1::uuid", [shop]))[0].n);
    expect(left).toBe(1); // the fresh one remains
  });

  it("reduces old notified/unsubscribed rows to a hashed-email suppression record", async () => {
    await db.withShopExec(shop, async (e) => {
      await e.run(
        `INSERT INTO back_in_stock_subscription (id,shop_id,product_id,shopify_product_gid,variant_key,email,email_hash,locale,status,unsubscribe_token_hash,created_at,updated_at)
         VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3,'',$4,$5,'en','notified','h'||$4, now() - interval '400 days', now() - interval '400 days')`,
        [shop, pid, G(1), "done@e.com", emailHash(shop, "done@e.com")],
      );
    });
    const r = await db.withShopExec(shop, (e) => purgeRestockData(e, shop, { now: new Date() }));
    expect(r.reducedToSuppression).toBe(1);
    const sub = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM back_in_stock_subscription WHERE shop_id=$1::uuid", [shop]))[0].n);
    const sup = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM restock_suppression WHERE shop_id=$1::uuid AND reason='retention'", [shop]))[0].n);
    expect(sub).toBe(0);  // plaintext row deleted
    expect(sup).toBe(1);  // reduced to a hashed suppression record
  });

  it("purge is bounded by the batch size", async () => {
    await db.withShopExec(shop, async (e) => {
      for (let i = 0; i < 5; i++) {
        await e.run(
          `INSERT INTO back_in_stock_subscription (id,shop_id,product_id,shopify_product_gid,variant_key,email,email_hash,locale,status,unsubscribe_token_hash,created_at,updated_at)
           VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3,'',$4,$5,'en','pending','h'||$4, now() - interval '10 days', now() - interval '10 days')`,
          [shop, pid, G(1), `b${i}@e.com`, emailHash(shop, `b${i}@e.com`)],
        );
      }
    });
    const r = await db.withShopExec(shop, (e) => purgeRestockData(e, shop, { now: new Date(), batchSize: 2 }));
    expect(r.unconfirmedPurged).toBe(2); // capped at the batch size
  });
});

describe("Phase 12.7 — GDPR data operations (data_request / redact)", () => {
  let db: TestDb; let shop: string; let pid: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p12gdpr.myshopify.com");
    pid = await seedUnavailable(db, shop, 1);
  });

  it("counts what is held for an email, then deletes it idempotently (cascading the ledger)", async () => {
    const sub = await db.withShopExec(shop, (e) => subscribe(e, shop, { email: "gdpr@e.com", productGid: G(1), consent: true }));
    await db.withShopExec(shop, (e) => confirmSubscription(e, shop, sub.subscriptionId!, sub.confirmToken!));
    await db.withShopExec(shop, (e) => e.run(`INSERT INTO restock_notification (shop_id,subscription_id,epoch,status) VALUES ($1::uuid,$2::uuid,1,'pending')`, [shop, sub.subscriptionId]));
    const hash = emailHash(shop, "gdpr@e.com");
    // data_request: count held (mirrors compliance.server.ts)
    const held = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM back_in_stock_subscription WHERE shop_id=$1::uuid AND email_hash=$2", [shop, hash]))[0].n);
    expect(held).toBe(1);
    // redact (admin delete-all for the email also suppresses it)
    const n = await db.withShopExec(shop, (e) => deleteAllForEmail(e, shop, "GDPR@E.com"));
    expect(n).toBe(1);
    const subsLeft = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM back_in_stock_subscription WHERE shop_id=$1::uuid", [shop]))[0].n);
    const notifLeft = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM restock_notification WHERE shop_id=$1::uuid", [shop]))[0].n);
    expect(subsLeft).toBe(0);
    expect(notifLeft).toBe(0); // cascaded from the subscription delete
    // idempotent second call
    expect(await db.withShopExec(shop, (e) => deleteAllForEmail(e, shop, "gdpr@e.com"))).toBe(0);
    void pid;
  });
});
