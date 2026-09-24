import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import {
  runFullSync,
  applyProductUpsert,
  applyProductDeletion,
} from "~/lib/sync/orchestrator";
import { getActiveVersion } from "~/lib/index/engine";

const PRODUCTS_JSONL = [
  `{"id":"gid://shopify/Product/1","title":"Red Shoe","vendor":"Acme","productType":"Shoes","tags":["red"],"updatedAt":"2026-01-01T00:00:00Z"}`,
  `{"id":"gid://shopify/ProductVariant/11","sku":"SKU-11","price":"19.99","__parentId":"gid://shopify/Product/1"}`,
  `{"id":"gid://shopify/Collection/100","__parentId":"gid://shopify/Product/1"}`,
  `{"id":"gid://shopify/Product/2","title":"Blue Hat","vendor":"Acme","productType":"Hats","tags":["blue"],"updatedAt":"2026-01-01T00:00:00Z"}`,
].join("\n");

const COLLECTIONS_JSONL = `{"id":"gid://shopify/Collection/100","title":"Footwear","handle":"footwear"}`;

async function activeDocCount(db: TestDb, shopId: string): Promise<number> {
  return db.withShopExec(shopId, async (e) => {
    const active = await getActiveVersion(e, shopId);
    if (!active) return 0;
    const rows = await e.rows<{ n: number }>(
      "SELECT count(*)::int n FROM product_search_doc WHERE shop_id=$1 AND index_version_id=$2",
      [shopId, active.id],
    );
    return rows[0].n;
  });
}

describe("sync orchestrator (bulk full + incremental)", () => {
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

  it("runs a full bulk sync and activates a version with denormalised docs", async () => {
    const res = await runFullSync(db.withShopExec, shopA, {
      productsJsonl: PRODUCTS_JSONL,
      collectionsJsonl: COLLECTIONS_JSONL,
      shopifyObjectCount: 2,
    });
    expect(res.ok).toBe(true);
    expect(res.productCount).toBe(2);
    expect(res.docCount).toBe(2);
    expect(res.version).toBe(1);

    const active = await db.withShopExec(shopA, (e) => getActiveVersion(e, shopA));
    expect(active?.version).toBe(1);

    // product 1's doc should include its variant SKU and collection title
    const doc = await db.withShopExec(shopA, (e) =>
      e.rows<{ search_text: string }>(
        `SELECT search_text FROM product_search_doc
         WHERE shop_id=$1 AND shopify_product_gid=$2`,
        [shopA, "gid://shopify/Product/1"],
      ),
    );
    expect(doc[0].search_text).toContain("SKU-11");
    expect(doc[0].search_text).toContain("Footwear");
  });

  it("full sync is tenant-isolated (shop B sees none of shop A's docs)", async () => {
    await runFullSync(db.withShopExec, shopA, {
      productsJsonl: PRODUCTS_JSONL,
      collectionsJsonl: COLLECTIONS_JSONL,
      shopifyObjectCount: 2,
    });
    expect(await activeDocCount(db, shopB)).toBe(0);
    expect(await activeDocCount(db, shopA)).toBe(2);
  });

  it("re-running full sync creates a new version and swaps atomically", async () => {
    await runFullSync(db.withShopExec, shopA, {
      productsJsonl: PRODUCTS_JSONL,
      shopifyObjectCount: 2,
    });
    const res2 = await runFullSync(db.withShopExec, shopA, {
      productsJsonl: PRODUCTS_JSONL,
      shopifyObjectCount: 2,
    });
    expect(res2.version).toBe(2);
    const activeCount = await db.withShopExec(shopA, (e) =>
      e.rows<{ n: number }>(
        "SELECT count(*)::int n FROM index_version WHERE shop_id=$1 AND status='active'",
        [shopA],
      ),
    );
    expect(activeCount[0].n).toBe(1);
  });

  it("incremental upsert refreshes the active index in place", async () => {
    await runFullSync(db.withShopExec, shopA, {
      productsJsonl: PRODUCTS_JSONL,
      shopifyObjectCount: 2,
    });
    expect(await activeDocCount(db, shopA)).toBe(2);

    await applyProductUpsert(db.withShopExec, shopA, {
      product: { shopifyProductGid: "gid://shopify/Product/3", title: "Green Sock" },
      variants: [],
      collectionGids: [],
    });
    expect(await activeDocCount(db, shopA)).toBe(3);
  });

  it("incremental delete removes the product's doc from the active index", async () => {
    await runFullSync(db.withShopExec, shopA, {
      productsJsonl: PRODUCTS_JSONL,
      shopifyObjectCount: 2,
    });
    await applyProductDeletion(db.withShopExec, shopA, "gid://shopify/Product/1");
    expect(await activeDocCount(db, shopA)).toBe(1);
  });
});
