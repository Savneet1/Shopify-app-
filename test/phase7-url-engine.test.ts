import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
} from "~/lib/index/engine";
import { storefrontSearchWithExec } from "~/lib/search/storefront";

/*
 * Phase 7.1 F1(e) — ties the client URL validation to the REAL payload shape.
 * Seeds products exactly like production (ABSOLUTE onlineStoreUrl + an absolute
 * CDN featuredImageUrl with ?v=), runs the real storefrontSearchWithExec, and
 * passes every returned product.url / image.url through the core validators,
 * asserting none is rejected. The pre-7.1 isSafeUrl (root-relative only) would
 * have dropped all of them.
 */
const require = createRequire(import.meta.url);
const COREPATH = join(__dirname, "..", "extensions", "search-discovery-theme", "assets", "boost-core.js");
const req = require(COREPATH);
const Core = req && req.toSameSitePath ? req : (globalThis as any).BoostSearch;

const SHOP_HOST = "shop.myshopify.com";
const CDN_HOST = "cdn.shopify.com";

async function seed(db: TestDb, shop: string, gid: string, handle: string) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: gid,
      title: "Red Running Shoe",
      handle,
      vendor: "Nike",
      productType: "Shoe",
      tags: ["red"],
      status: "ACTIVE",
      // Production shapes: absolute onlineStoreUrl + absolute CDN image URL.
      onlineStoreUrl: `https://${SHOP_HOST}/products/${handle}`,
      featuredImageUrl: `https://${CDN_HOST}/s/files/1/0001/0002/products/${handle}.jpg?v=1700000000`,
      featuredImageAlt: "Red Running Shoe",
      metafields: {},
      productCreatedAt: "2024-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: gid + "/v", sku: "SKU-" + gid, price: "50.00", availableForSale: true });
  });
}

describe("Phase 7.1 — real payload URLs pass the client validators", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop(SHOP_HOST);
    await seed(db, shop, "1", "red-running-shoe");
    await seed(db, shop, "2", "red-sandal");
    const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
    const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  });

  it("every returned product.url resolves to a same-site path; every image.url is an allowed CDN image", async () => {
    const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "red shoe" }));
    expect(r.products.length).toBeGreaterThan(0);
    for (const p of r.products) {
      // sanity: the engine really does emit absolute URLs (the bug's premise).
      expect(String(p.url).startsWith("https://")).toBe(true);
      expect(String(p.image.url).startsWith("https://")).toBe(true);
      const path = Core.toSameSitePath(p.url, [SHOP_HOST], SHOP_HOST);
      expect(path, p.url ?? "").not.toBeNull();
      expect(String(path).startsWith("/products/")).toBe(true);
      expect(Core.isSafeImageUrl(p.image.url, [CDN_HOST]), p.image.url ?? "").toBe(true);
    }
  });
});
