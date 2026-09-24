import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import {
  upsertProduct,
  upsertVariant,
  upsertCollection,
  replaceProductCollectionsByGids,
  softDeleteProductByGid,
  countLiveProducts,
} from "~/lib/catalog/store";

describe("catalog store (upsert idempotency, soft delete, tenancy)", () => {
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

  it("upsert is idempotent (same GID -> same row, fields updated)", async () => {
    const id1 = await db.withShopExec(shopA, (e) =>
      upsertProduct(e, shopA, {
        shopifyProductGid: "gid://shopify/Product/1",
        title: "Red Shoe",
        vendor: "Acme",
        tags: ["red", "shoe"],
      }),
    );
    const id2 = await db.withShopExec(shopA, (e) =>
      upsertProduct(e, shopA, {
        shopifyProductGid: "gid://shopify/Product/1",
        title: "Red Running Shoe",
        vendor: "Acme",
        tags: ["red", "shoe", "running"],
      }),
    );
    expect(id2.id).toBe(id1.id);
    const rows = await db.withShopExec(shopA, (e) =>
      e.rows<{ title: string; n: number }>(
        "SELECT title FROM product WHERE shop_id=$1::uuid",
        [shopA],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Red Running Shoe");
  });

  it("upserts variants and collection memberships", async () => {
    const { id: pid } = await db.withShopExec(shopA, (e) =>
      upsertProduct(e, shopA, { shopifyProductGid: "gid://shopify/Product/1", title: "P" }),
    );
    await db.withShopExec(shopA, async (e) => {
      await upsertVariant(e, shopA, pid, {
        shopifyVariantGid: "gid://shopify/ProductVariant/10",
        sku: "SKU-10",
        price: "19.99",
      });
      await upsertCollection(e, shopA, {
        shopifyCollectionGid: "gid://shopify/Collection/100",
        title: "Shoes",
      });
      await replaceProductCollectionsByGids(e, shopA, pid, [
        "gid://shopify/Collection/100",
      ]);
    });
    const counts = await db.withShopExec(shopA, async (e) => ({
      variants: (
        await e.rows<{ n: number }>("SELECT count(*)::int n FROM variant WHERE shop_id=$1", [shopA])
      )[0].n,
      memberships: (
        await e.rows<{ n: number }>(
          "SELECT count(*)::int n FROM product_collection WHERE shop_id=$1",
          [shopA],
        )
      )[0].n,
    }));
    expect(counts.variants).toBe(1);
    expect(counts.memberships).toBe(1);
  });

  it("soft delete removes a product from the live count", async () => {
    await db.withShopExec(shopA, (e) =>
      upsertProduct(e, shopA, { shopifyProductGid: "gid://shopify/Product/1", title: "P" }),
    );
    expect(await db.withShopExec(shopA, (e) => countLiveProducts(e, shopA))).toBe(1);
    const affected = await db.withShopExec(shopA, (e) =>
      softDeleteProductByGid(e, shopA, "gid://shopify/Product/1"),
    );
    expect(affected).toBe(1);
    expect(await db.withShopExec(shopA, (e) => countLiveProducts(e, shopA))).toBe(0);
  });

  it("catalog rows are tenant-isolated (B cannot see A's products)", async () => {
    await db.withShopExec(shopA, (e) =>
      upsertProduct(e, shopA, { shopifyProductGid: "gid://shopify/Product/1", title: "P" }),
    );
    expect(await db.withShopExec(shopB, (e) => countLiveProducts(e, shopB))).toBe(0);
  });

  it("cannot upsert a product tagged for another shop (RLS WITH CHECK)", async () => {
    await expect(
      db.withShopExec(shopB, (e) =>
        upsertProduct(e, shopA, {
          shopifyProductGid: "gid://shopify/Product/x",
          title: "hijack",
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
