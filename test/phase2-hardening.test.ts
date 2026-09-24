import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import {
  upsertProduct,
  softDeleteProductByGid,
} from "~/lib/catalog/store";
import {
  runFullSync,
  applyProductUpsert,
  applyProductChange,
  applyProductDeletion,
} from "~/lib/sync/orchestrator";
import {
  createIndexVersion,
  buildDocs,
  validateIndexVersion,
  activateIndexVersion,
  getActiveVersion,
} from "~/lib/index/engine";
import { parseProductsJsonl } from "~/lib/catalog/bulk-parse";
import { normalizeProductNode } from "~/lib/catalog/normalize";

const T1 = "2026-01-01T00:00:00Z";
const T2 = "2026-02-02T00:00:00Z";
const T3 = "2026-03-03T00:00:00Z";

async function activeDocCount(db: TestDb, shopId: string): Promise<number> {
  return db.withShopExec(shopId, async (e) => {
    const active = await getActiveVersion(e, shopId);
    if (!active) return 0;
    return (
      await e.rows<{ n: number }>(
        "SELECT count(*)::int n FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid",
        [shopId, active.id],
      )
    )[0].n;
  });
}
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

describe("Phase 2.1 hardening regressions", () => {
  let db: TestDb;
  let shopA: string;

  beforeAll(async () => {
    db = makeDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("shop-a.myshopify.com");
  });

  it("P1: a stale out-of-order update must not overwrite newer data", async () => {
    const G = "gid://shopify/Product/1";
    await db.withShopExec(shopA, (e) => upsertProduct(e, shopA, { shopifyProductGid: G, title: "New", shopifyUpdatedAt: T2 }));
    await db.withShopExec(shopA, (e) => upsertProduct(e, shopA, { shopifyProductGid: G, title: "Old", shopifyUpdatedAt: T1 }));
    const title = (
      await db.withShopExec(shopA, (e) => e.rows<{ title: string }>("SELECT title FROM product WHERE shop_id=$1::uuid", [shopA]))
    )[0].title;
    expect(title).toBe("New");
  });

  it("P2: a late update after a delete must not resurrect the product", async () => {
    const G = "gid://shopify/Product/1";
    await db.withShopExec(shopA, (e) => upsertProduct(e, shopA, { shopifyProductGid: G, title: "V1", shopifyUpdatedAt: T1 }));
    await db.withShopExec(shopA, (e) => softDeleteProductByGid(e, shopA, G));
    // stale update (older than the delete tombstone) must NOT un-delete
    await db.withShopExec(shopA, (e) => upsertProduct(e, shopA, { shopifyProductGid: G, title: "resurrected", shopifyUpdatedAt: T1 }));
    const row = (
      await db.withShopExec(shopA, (e) => e.rows<{ deleted_at: string | null; title: string }>("SELECT deleted_at, title FROM product WHERE shop_id=$1::uuid AND shopify_product_gid=$2", [shopA, G]))
    )[0];
    expect(row.deleted_at).not.toBeNull();
    expect(row.title).toBe("V1");
  });

  it("P3: a variant removed in Shopify disappears from the catalog and the index doc", async () => {
    const G = "gid://shopify/Product/1";
    const productsJsonl = [
      `{"id":"${G}","title":"Shoe","status":"ACTIVE","updatedAt":"${T1}"}`,
      `{"id":"gid://shopify/ProductVariant/11","sku":"SKU-1","updatedAt":"${T1}","__parentId":"${G}"}`,
      `{"id":"gid://shopify/ProductVariant/12","sku":"SKU-2","updatedAt":"${T1}","__parentId":"${G}"}`,
    ].join("\n");
    const res = await runFullSync(db.withShopExec, shopA, { productsJsonl, shopifyObjectCount: 3 });
    expect(res.ok).toBe(true);
    expect(await activeSearchText(db, shopA, G)).toContain("SKU-2");

    // Shopify now returns the product with only variant 11.
    await applyProductChange(db.withShopExec, shopA, G, async () => ({
      id: G, title: "Shoe", status: "ACTIVE", updatedAt: T3,
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", sku: "SKU-1", updatedAt: T3 }] },
      collections: { nodes: [] },
    }));

    const v2 = (
      await db.withShopExec(shopA, (e) => e.rows<{ deleted_at: string | null }>("SELECT deleted_at FROM variant WHERE shop_id=$1::uuid AND shopify_variant_gid=$2", [shopA, "gid://shopify/ProductVariant/12"]))
    )[0];
    expect(v2.deleted_at).not.toBeNull();
    const text = await activeSearchText(db, shopA, G);
    expect(text).toContain("SKU-1");
    expect(text).not.toContain("SKU-2");
  });

  it("P4: a full sync removes products and collections no longer in Shopify", async () => {
    const collA = `{"id":"gid://shopify/Collection/1","title":"C1"}\n{"id":"gid://shopify/Collection/2","title":"C2"}`;
    const prodA = [
      `{"id":"gid://shopify/Product/1","title":"P1","updatedAt":"${T1}"}`,
      `{"id":"gid://shopify/Product/2","title":"P2","updatedAt":"${T1}"}`,
    ].join("\n");
    await runFullSync(db.withShopExec, shopA, { productsJsonl: prodA, collectionsJsonl: collA, shopifyObjectCount: 2 });
    expect(await activeDocCount(db, shopA)).toBe(2);

    // Snapshot B: only P1 / C1 remain.
    const collB = `{"id":"gid://shopify/Collection/1","title":"C1"}`;
    const prodB = `{"id":"gid://shopify/Product/1","title":"P1","updatedAt":"${T2}"}`;
    await runFullSync(db.withShopExec, shopA, { productsJsonl: prodB, collectionsJsonl: collB, shopifyObjectCount: 1 });

    expect(await activeDocCount(db, shopA)).toBe(1);
    const gone = await db.withShopExec(shopA, async (e) => ({
      p2: (await e.rows<{ deleted_at: string | null }>("SELECT deleted_at FROM product WHERE shop_id=$1::uuid AND shopify_product_gid='gid://shopify/Product/2'", [shopA]))[0].deleted_at,
      c2: (await e.rows<{ deleted_at: string | null }>("SELECT deleted_at FROM collection WHERE shop_id=$1::uuid AND shopify_collection_gid='gid://shopify/Collection/2'", [shopA]))[0].deleted_at,
    }));
    expect(gone.p2).not.toBeNull();
    expect(gone.c2).not.toBeNull();
  });

  it("P5: a webhook applied between buildDocs and activate survives activation", async () => {
    const prod = [
      `{"id":"gid://shopify/Product/1","title":"P1","updatedAt":"${T1}"}`,
      `{"id":"gid://shopify/Product/2","title":"P2","updatedAt":"${T1}"}`,
    ].join("\n");
    await runFullSync(db.withShopExec, shopA, { productsJsonl: prod, shopifyObjectCount: 2 }); // active v1 (2 docs)

    // Build v2 from the 2-product snapshot, validate it.
    const v2 = await db.withShopExec(shopA, (e) => createIndexVersion(e, shopA, "full", 2));
    await db.withShopExec(shopA, (e) => buildDocs(e, shopA, v2.id));
    const val = await db.withShopExec(shopA, (e) => validateIndexVersion(e, shopA, v2.id, 2));
    expect(val.pass).toBe(true);

    // A webhook arrives BETWEEN build/validate and activation: new product P3.
    await applyProductUpsert(db.withShopExec, shopA, {
      product: { shopifyProductGid: "gid://shopify/Product/3", title: "P3", shopifyUpdatedAt: T3 },
      variants: [], collectionGids: [],
    });

    // Activation must catch up P3 into v2.
    await db.withShopExec(shopA, (e) => activateIndexVersion(e, shopA, v2.id));
    expect(await activeDocCount(db, shopA)).toBe(3);
  });

  it("P5b: a delete during build is reflected in the activated version", async () => {
    const prod = [
      `{"id":"gid://shopify/Product/1","title":"P1","updatedAt":"${T1}"}`,
      `{"id":"gid://shopify/Product/2","title":"P2","updatedAt":"${T1}"}`,
    ].join("\n");
    await runFullSync(db.withShopExec, shopA, { productsJsonl: prod, shopifyObjectCount: 2 });

    const v2 = await db.withShopExec(shopA, (e) => createIndexVersion(e, shopA, "full", 2));
    await db.withShopExec(shopA, (e) => buildDocs(e, shopA, v2.id));
    await db.withShopExec(shopA, (e) => validateIndexVersion(e, shopA, v2.id, 2));

    // Delete P2 between build and activate.
    await applyProductDeletion(db.withShopExec, shopA, "gid://shopify/Product/2");

    await db.withShopExec(shopA, (e) => activateIndexVersion(e, shopA, v2.id));
    expect(await activeDocCount(db, shopA)).toBe(1);
  });

  it("P6: webhook (single-fetch) and bulk paths normalise identically", async () => {
    const G = "gid://shopify/Product/1";
    const productsJsonl = [
      `{"id":"${G}","title":"Shoe","status":"ACTIVE","description":"Plain desc","productType":"Shoes","tags":["a"],"updatedAt":"${T1}"}`,
      `{"id":"gid://shopify/ProductVariant/11","sku":"S1","title":"M","price":"1.00","position":1,"selectedOptions":[{"name":"Size","value":"M"}],"availableForSale":true,"updatedAt":"${T1}","__parentId":"${G}"}`,
      `{"id":"gid://shopify/Collection/100","__parentId":"${G}"}`,
    ].join("\n");
    const [fromBulk] = parseProductsJsonl(productsJsonl);

    const singleNode = {
      id: G, title: "Shoe", status: "ACTIVE", description: "Plain desc", productType: "Shoes",
      tags: ["a"], updatedAt: T1,
      variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/11", sku: "S1", title: "M", price: "1.00", position: 1, selectedOptions: [{ name: "Size", value: "M" }], availableForSale: true, updatedAt: T1 } }] },
      collections: { edges: [{ node: { id: "gid://shopify/Collection/100" } }] },
    };
    const fromSingle = normalizeProductNode(singleNode);

    expect(fromBulk).toEqual(fromSingle);
    expect(fromBulk.product.status).toBe("ACTIVE");
    expect(fromBulk.variants[0].position).toBe(1);
    expect(fromBulk.collectionGids).toEqual(["gid://shopify/Collection/100"]);
  });
});
