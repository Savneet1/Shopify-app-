import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
  refreshDocsForProducts,
} from "~/lib/index/engine";
import { applyProductUpsert, applyProductDeletion } from "~/lib/sync/orchestrator";
import type { NormalizedProduct } from "~/lib/catalog/bulk-parse";

/*
 * Phase 13b C2 — a combined PARENT's derived aggregate is refreshed whenever a
 * CHILD changes through any incremental path, without waiting for the parent to
 * change. Old + new parent on reparent/un-child. Bounded, deduped, idempotent;
 * a non-combined update issues NO parent-refresh statement.
 */

const G = (n: number) => `gid://shopify/Product/${n}`;
const handleOf = (gid: string) => gid.split("/").pop()!;
const PARENT_REFRESH_MARKER = "combined_role='PARENT'"; // unique to refreshCombinedParentDocs

interface Seed {
  gid: string; title: string; price: string; available?: boolean; status?: string;
  published?: boolean; combinedRole?: "PARENT" | "CHILD" | null; combinedParentGid?: string | null; updatedAt?: string;
}
async function seed(db: TestDb, shop: string, s: Seed): Promise<void> {
  await db.withShopExec(shop, async (e) => {
    const published = s.published !== false;
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: s.gid, title: s.title, handle: handleOf(s.gid), status: s.status ?? "ACTIVE",
      onlineStoreUrl: published ? `https://shop.example/products/${handleOf(s.gid)}` : null,
      metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z", shopifyUpdatedAt: s.updatedAt ?? "2024-01-01T00:00:00Z",
      combinedRole: s.combinedRole ?? null, combinedParentGid: s.combinedParentGid ?? null,
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: s.gid + "/v", price: s.price, availableForSale: s.available ?? true });
  });
}
async function build(db: TestDb, shop: string): Promise<void> {
  const n = await db.withShopExec(shop, async (e) =>
    (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
}
function parentDoc(db: TestDb, shop: string, gid: string): Promise<any> {
  return db.withShopExec(shop, async (e) =>
    (await e.rows<{ doc: any }>(
      `SELECT d.doc FROM product_search_doc d JOIN index_version iv ON iv.id=d.index_version_id AND iv.status='active'
       WHERE d.shop_id=$1::uuid AND d.shopify_product_gid=$2`, [shop, gid]))[0]?.doc);
}
// A NormalizedProduct for an incremental child/product update.
function np(p: Partial<Seed> & { gid: string }): NormalizedProduct {
  const published = p.published !== false;
  return {
    product: {
      shopifyProductGid: p.gid, title: p.title ?? "x", handle: handleOf(p.gid), status: p.status ?? "ACTIVE",
      onlineStoreUrl: published ? `https://shop.example/products/${handleOf(p.gid)}` : null,
      metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z", shopifyUpdatedAt: p.updatedAt ?? "2025-01-01T00:00:00Z",
      combinedRole: p.combinedRole ?? null, combinedParentGid: p.combinedParentGid ?? null,
    },
    variants: [{ shopifyVariantGid: p.gid + "/v", price: p.price ?? "1.00", availableForSale: p.available ?? true }],
    collectionGids: [], variantsComplete: true, collectionsComplete: true,
  } as unknown as NormalizedProduct;
}
// A runner that records every SQL string issued, for query-count assertions.
function recordingRunner(db: TestDb, log: string[]) {
  return <T>(shopId: string, fn: (e: Exec) => Promise<T>): Promise<T> =>
    db.withShopExec(shopId, (e: Exec) => {
      const rec: Exec = {
        rows: (sql: string, params?: unknown[]) => { log.push(sql); return e.rows(sql, params as unknown[]); },
        run: (sql: string, params?: unknown[]) => { log.push(sql); return e.run(sql, params as unknown[]); },
      };
      return fn(rec);
    });
}

const P = G(1), PB = G(2), A = G(11), B = G(12), PLAIN = G(20);

describe("Phase 13b C2 — parent aggregate refreshes on child change", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p13bc2.myshopify.com");
    await seed(db, shop, { gid: P, title: "Parent", price: "999.00", combinedRole: "PARENT" });
    await seed(db, shop, { gid: PB, title: "Parent B", price: "999.00", combinedRole: "PARENT" });
    await seed(db, shop, { gid: A, title: "Child A", price: "40.00", combinedRole: "CHILD", combinedParentGid: P });
    await seed(db, shop, { gid: B, title: "Child B", price: "55.00", combinedRole: "CHILD", combinedParentGid: P });
    await seed(db, shop, { gid: PLAIN, title: "Plain", price: "7.00" });
    await build(db, shop);
  });

  it("baseline aggregate after build", async () => {
    const d = await parentDoc(db, shop, P);
    expect(d.combinedChildCount).toBe(2);
    expect(Number(d.combinedPriceMax)).toBe(55);
  });

  it("a child PRICE change updates the parent's aggregate immediately", async () => {
    await applyProductUpsert(db.withShopExec, shop, np({ gid: B, title: "Child B", price: "99.00", combinedRole: "CHILD", combinedParentGid: P }));
    const d = await parentDoc(db, shop, P);
    expect(Number(d.combinedPriceMax)).toBe(99);
  });

  it("a child AVAILABILITY change updates the parent's range (OOS rule)", async () => {
    // B becomes unavailable → range falls back to available child A only (40..40)
    await applyProductUpsert(db.withShopExec, shop, np({ gid: B, title: "Child B", price: "55.00", available: false, combinedRole: "CHILD", combinedParentGid: P }));
    const d = await parentDoc(db, shop, P);
    expect(Number(d.combinedPriceMin)).toBe(40);
    expect(Number(d.combinedPriceMax)).toBe(40);
  });

  it("a child STATUS change (ACTIVE→DRAFT) drops it from the parent", async () => {
    await applyProductUpsert(db.withShopExec, shop, np({ gid: B, title: "Child B", price: "55.00", status: "DRAFT", combinedRole: "CHILD", combinedParentGid: P }));
    const d = await parentDoc(db, shop, P);
    expect(d.combinedChildCount).toBe(1);
    expect(Number(d.combinedPriceMax)).toBe(40);
  });

  it("deleting a child updates the parent", async () => {
    await applyProductDeletion(db.withShopExec, shop, B);
    const d = await parentDoc(db, shop, P);
    expect(d.combinedChildCount).toBe(1);
    expect(Number(d.combinedPriceMax)).toBe(40);
  });

  it("reparenting a child refreshes BOTH the old and the new parent", async () => {
    await applyProductUpsert(db.withShopExec, shop, np({ gid: B, title: "Child B", price: "55.00", combinedRole: "CHILD", combinedParentGid: PB }));
    const oldP = await parentDoc(db, shop, P);
    const newP = await parentDoc(db, shop, PB);
    expect(oldP.combinedChildCount).toBe(1); // B left P
    expect(newP.combinedChildCount).toBe(1); // B joined PB
    expect(Number(newP.combinedPriceMax)).toBe(55);
  });

  it("un-childing a product (role removed) refreshes the old parent", async () => {
    await applyProductUpsert(db.withShopExec, shop, np({ gid: B, title: "Child B", price: "55.00", combinedRole: null, combinedParentGid: null }));
    const d = await parentDoc(db, shop, P);
    expect(d.combinedChildCount).toBe(1);
  });

  it("an out-of-order (older) child update is idempotent — parent unchanged", async () => {
    // older updatedAt than the seed (2024-01-01) → monotonic guard skips the child
    await applyProductUpsert(db.withShopExec, shop, np({ gid: B, title: "Child B", price: "1.00", updatedAt: "2020-01-01T00:00:00Z", combinedRole: "CHILD", combinedParentGid: P }));
    const d = await parentDoc(db, shop, P);
    expect(Number(d.combinedPriceMax)).toBe(55); // child skipped → aggregate unchanged
  });

  it("a batch refresh with N children of one parent refreshes the parent exactly once", async () => {
    const ids = await db.withShopExec(shop, async (e) =>
      (await e.rows<{ id: string }>(`SELECT id FROM product WHERE shop_id=$1::uuid AND shopify_product_gid = ANY($2::text[])`, [shop, [A, B]])).map((r) => r.id));
    const log: string[] = [];
    await recordingRunner(db, log)(shop, (e) => refreshDocsForProducts(e, shop, ids));
    const parentRefreshes = log.filter((s) => s.includes(PARENT_REFRESH_MARKER)).length;
    expect(parentRefreshes).toBe(1);
  });

  it("a NON-combined product update issues NO parent-refresh statement", async () => {
    const log: string[] = [];
    await applyProductUpsert(recordingRunner(db, log), shop, np({ gid: PLAIN, title: "Plain", price: "8.00" }));
    expect(log.some((s) => s.includes(PARENT_REFRESH_MARKER))).toBe(false);
  });

  it("a combined CHILD update issues exactly ONE parent-refresh statement", async () => {
    const log: string[] = [];
    await applyProductUpsert(recordingRunner(db, log), shop, np({ gid: A, title: "Child A", price: "41.00", combinedRole: "CHILD", combinedParentGid: P }));
    expect(log.filter((s) => s.includes(PARENT_REFRESH_MARKER)).length).toBe(1);
  });
});
