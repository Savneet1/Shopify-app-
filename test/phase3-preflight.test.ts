import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import {
  runFullSync,
  applyProductChange,
  applyCollectionChange,
} from "~/lib/sync/orchestrator";
import { updateShopLastFullSync } from "~/lib/catalog/store";
import { getActiveVersion } from "~/lib/index/engine";
import { runReconciliationTick } from "~/lib/jobs/maintenance";

async function activeSearchText(db: TestDb, shopId: string, gid: string): Promise<string> {
  return db.withShopExec(shopId, async (e) => {
    const active = await getActiveVersion(e, shopId);
    const rows = await e.rows<{ search_text: string }>(
      "SELECT search_text FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND shopify_product_gid=$3",
      [shopId, active!.id, gid],
    );
    return rows[0]?.search_text ?? "";
  });
}
async function deletedAt(db: TestDb, shopId: string, table: string, col: string, gid: string) {
  return db.withShopExec(shopId, async (e) => {
    const rows = await e.rows<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM ${table} WHERE shop_id=$1::uuid AND ${col}=$2`,
      [shopId, gid],
    );
    return rows[0]?.deleted_at ?? null;
  });
}

describe("Phase 3 preflight (G4/G6/G7/G8)", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;

  beforeAll(async () => {
    db = makeDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("shop-a.myshopify.com");
    shopB = await db.resolveShop("shop-b.myshopify.com");
  });

  it("G4: reconciliation only deletes rows older than the snapshot start", async () => {
    // Establish catalog p1,p2,p4.
    const first = [
      `{"id":"gid://shopify/Product/1","title":"P1","updatedAt":"2026-01-01T00:00:00Z"}`,
      `{"id":"gid://shopify/Product/2","title":"P2","updatedAt":"2026-01-01T00:00:00Z"}`,
      `{"id":"gid://shopify/Product/4","title":"P4","updatedAt":"2026-01-01T00:00:00Z"}`,
    ].join("\n");
    await runFullSync(db.withShopExec, shopA, { productsJsonl: first, shopifyObjectCount: 3 });

    const snapStart = new Date(); // a new bulk snapshot begins here
    await new Promise((r) => setTimeout(r, 20));
    // p3 created by webhook AFTER the snapshot start (absent from the snapshot).
    await applyProductChange(db.withShopExec, shopA, "gid://shopify/Product/3", async () => ({
      id: "gid://shopify/Product/3", title: "P3", status: "ACTIVE", updatedAt: new Date().toISOString(),
      variants: { nodes: [] }, collections: { nodes: [] },
    }));

    // Second full sync snapshot has only p1,p2 (p3 too new to be in it; p4 gone).
    const second = [
      `{"id":"gid://shopify/Product/1","title":"P1","updatedAt":"2026-02-01T00:00:00Z"}`,
      `{"id":"gid://shopify/Product/2","title":"P2","updatedAt":"2026-02-01T00:00:00Z"}`,
    ].join("\n");
    await runFullSync(db.withShopExec, shopA, {
      productsJsonl: second, shopifyObjectCount: 2, snapshotStartedAt: snapStart,
    });

    // p3 (created after snapshot) survives; p4 (older, absent) is deleted.
    expect(await deletedAt(db, shopA, "product", "shopify_product_gid", "gid://shopify/Product/3")).toBeNull();
    expect(await deletedAt(db, shopA, "product", "shopify_product_gid", "gid://shopify/Product/4")).not.toBeNull();
  });

  it("G6: >250 variants are not truncated; an incomplete page skips reconcile", async () => {
    // 300 variants via a fake fetcher (complete).
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `gid://shopify/ProductVariant/${i + 1}`, sku: `SKU-${i + 1}`, updatedAt: "2026-03-01T00:00:00Z",
    }));
    await applyProductChange(db.withShopExec, shopA, "gid://shopify/Product/1", async () => ({
      id: "gid://shopify/Product/1", title: "Big", status: "ACTIVE", updatedAt: "2026-03-01T00:00:00Z",
      variants: { nodes: many, pageInfo: { hasNextPage: false } }, collections: { nodes: [] },
    }));
    const count = await db.withShopExec(shopA, async (e) =>
      (await e.rows<{ n: number }>("SELECT count(*)::int n FROM variant WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shopA]))[0].n,
    );
    expect(count).toBe(300);

    // Incomplete re-fetch (hasNextPage) must NOT delete the unseen variants.
    await applyProductChange(db.withShopExec, shopA, "gid://shopify/Product/1", async () => ({
      id: "gid://shopify/Product/1", title: "Big", status: "ACTIVE", updatedAt: "2026-03-02T00:00:00Z",
      variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/1", sku: "SKU-1", updatedAt: "2026-03-02T00:00:00Z" } }], pageInfo: { hasNextPage: true } },
      collections: { nodes: [] },
    }));
    const stillLive = await db.withShopExec(shopA, async (e) =>
      (await e.rows<{ n: number }>("SELECT count(*)::int n FROM variant WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shopA]))[0].n,
    );
    expect(stillLive).toBe(300); // none deleted despite the partial view
  });

  it("G7: a collection rename refreshes member products' docs", async () => {
    const productsJsonl = [
      `{"id":"gid://shopify/Product/1","title":"Shoe","status":"ACTIVE","updatedAt":"2026-01-01T00:00:00Z"}`,
      `{"id":"gid://shopify/Collection/100","__parentId":"gid://shopify/Product/1"}`,
    ].join("\n");
    const collectionsJsonl = `{"id":"gid://shopify/Collection/100","title":"OldName"}`;
    await runFullSync(db.withShopExec, shopA, { productsJsonl, collectionsJsonl, shopifyObjectCount: 2 });
    expect(await activeSearchText(db, shopA, "gid://shopify/Product/1")).toContain("OldName");

    // Rename the collection.
    await applyCollectionChange(db.withShopExec, shopA, "gid://shopify/Collection/100", async () => ({
      id: "gid://shopify/Collection/100", title: "NewName", updatedAt: "2026-03-01T00:00:00Z",
    }));
    const text = await activeSearchText(db, shopA, "gid://shopify/Product/1");
    expect(text).toContain("NewName");
    expect(text).not.toContain("OldName");
  });

  it("G8: reconciliation tick enqueues only shops needing a sync", async () => {
    // shopB was fully synced recently; shopA never.
    await db.withShopExec(shopB, (e) => updateShopLastFullSync(e, shopB));
    const enqueued: string[] = [];
    const n = await runReconciliationTick(db.rootExec, async (id) => { enqueued.push(id); }, "24 hours");
    expect(enqueued).toContain(shopA);
    expect(enqueued).not.toContain(shopB);
    expect(n).toBe(enqueued.length);
  });
});
