import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { getPrisma } from "~/db.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { runFullSync, applyProductUpsert } from "~/lib/sync/orchestrator";
import {
  getActiveVersion, createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
} from "~/lib/index/engine";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { searchProducts } from "~/lib/search/query";
import { storefrontSearch } from "~/lib/search/storefront";
import { addSynonym } from "~/lib/search/synonyms";
import { claimWebhook, markWebhookProcessed } from "~/lib/webhooks/receipt.server";
import { sha256Hex } from "~/lib/webhooks/hmac.server";

/**
 * Prisma reality check (#4a): exercise the PRODUCTION data path — runFullSync +
 * an incremental apply + activation — through the real Prisma-backed
 * withShopExec (not node-postgres). This proves the raw-SQL parameter casts and
 * transaction wrapper work through Prisma.
 *
 * The Prisma query engine binary is downloaded from binaries.prisma.sh, which is
 * egress-blocked in this sandbox, so `getPrisma()` cannot connect here. When
 * that is the case this suite SKIPS with an explicit message; on a normal
 * machine (engine available) it runs in full.
 */
const PRODUCTS_JSONL = [
  `{"id":"gid://shopify/Product/1","title":"Red Shoe","vendor":"Acme","tags":["red"],"updatedAt":"2026-01-01T00:00:00Z"}`,
  `{"id":"gid://shopify/ProductVariant/11","sku":"SKU-11","price":"19.99","__parentId":"gid://shopify/Product/1"}`,
  `{"id":"gid://shopify/Product/2","title":"Blue Hat","vendor":"Acme","tags":["blue"],"updatedAt":"2026-01-01T00:00:00Z"}`,
].join("\n");

let prismaOk = false;
let prismaError = "";

describe("Prisma-backed integration (production withShopExec path)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = makeDb();
    try {
      await getPrisma().$queryRawUnsafe("SELECT 1");
      prismaOk = true;
    } catch (err) {
      prismaOk = false;
      prismaError = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[prisma-integration] SKIPPED: Prisma engine unavailable in this environment (${prismaError.split("\n")[0]})`,
      );
    }
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    if (prismaOk) await db.resetDb();
  });

  it("runs full sync + incremental + activation via Prisma", async (ctx) => {
    if (!prismaOk) return ctx.skip();

    const shopId = await resolveShopId("shop-a.myshopify.com");
    // Chunked full sync (force multiple transactions) through real Prisma.
    process.env.SYNC_CHUNK_SIZE = "1";
    const res = await runFullSync(withShopExec, shopId, {
      productsJsonl: PRODUCTS_JSONL,
      shopifyObjectCount: 2,
    });
    delete process.env.SYNC_CHUNK_SIZE;
    expect(res.ok).toBe(true);
    expect(res.version).toBe(1);

    await applyProductUpsert(withShopExec, shopId, {
      product: { shopifyProductGid: "gid://shopify/Product/3", title: "Green Sock", shopifyUpdatedAt: "2026-03-01T00:00:00Z" },
      variants: [],
      collectionGids: [],
    });

    const active = await withShopExec(shopId, (e) => getActiveVersion(e, shopId));
    expect(active?.version).toBe(1);
    const docs = await withShopExec(shopId, async (e) => {
      const rows = await e.rows<{ n: number }>(
        "SELECT count(*)::int n FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid",
        [shopId, active!.id],
      );
      return rows[0].n;
    });
    expect(docs).toBe(3);
  });

  it("Phase 3 full-text search via the production Prisma path", async (ctx) => {
    if (!prismaOk) return ctx.skip();
    const shopId = await resolveShopId("shop-a.myshopify.com");

    // Seed a published, ACTIVE product with a variant SKU through real Prisma.
    await withShopExec(shopId, async (e) => {
      const { id } = await upsertProduct(e, shopId, {
        shopifyProductGid: "gid://shopify/Product/100",
        title: "Crimson Trail Runner", vendor: "Acme", productType: "Shoe",
        status: "ACTIVE", onlineStoreUrl: "https://shop.test/crimson",
        featuredImageUrl: "https://img.test/c.jpg", featuredImageAlt: "Crimson",
      });
      await upsertVariant(e, shopId, id, {
        shopifyVariantGid: "gid://shopify/ProductVariant/1001",
        sku: "CRIM-1", price: "89.00", availableForSale: true, position: 1,
      });
    });
    const v = await withShopExec(shopId, (e) => createIndexVersion(e, shopId, "full", 1));
    await withShopExec(shopId, (e) => buildDocs(e, shopId, v.id));
    await withShopExec(shopId, (e) => validateIndexVersion(e, shopId, v.id, 1));
    await withShopExec(shopId, (e) => activateIndexVersion(e, shopId, v.id));

    // searchProducts uses the production withShopExec (Prisma) internally.
    const byTitle = await searchProducts(shopId, { q: "crimson runner" });
    expect(byTitle.fallback).toBeUndefined();
    expect(byTitle.products.map((p) => p.title)).toContain("Crimson Trail Runner");

    const bySku = await searchProducts(shopId, { q: "CRIM-1" });
    expect(bySku.products[0]?.title).toBe("Crimson Trail Runner");
  });

  it("Phase 4 filtered search + facets via the production Prisma path", async (ctx) => {
    if (!prismaOk) return ctx.skip();
    const shopId = await resolveShopId("shop-a.myshopify.com");

    // Two published, ACTIVE products with different vendors + a facet metafield.
    await withShopExec(shopId, async (e) => {
      for (const [n, vendor, material] of [
        ["200", "Acme", "Leather"],
        ["201", "Globex", "Canvas"],
      ] as const) {
        const { id } = await upsertProduct(e, shopId, {
          shopifyProductGid: `gid://shopify/Product/${n}`,
          title: `Bag ${n}`, vendor, productType: "Bag", status: "ACTIVE",
          onlineStoreUrl: `https://shop.test/bag-${n}`, tags: ["carry"],
          metafields: { "custom.material": material },
        });
        await upsertVariant(e, shopId, id, {
          shopifyVariantGid: `gid://shopify/ProductVariant/${n}1`,
          sku: `BAG-${n}`, price: "40.00", availableForSale: true, position: 1,
        });
      }
    });
    const v = await withShopExec(shopId, (e) => createIndexVersion(e, shopId, "full", 2));
    await withShopExec(shopId, (e) => buildDocs(e, shopId, v.id));
    await withShopExec(shopId, (e) => validateIndexVersion(e, shopId, v.id, 2));
    await withShopExec(shopId, (e) => activateIndexVersion(e, shopId, v.id));

    // storefrontSearch uses the production withShopExec (Prisma) internally.
    const r = await storefrontSearch(shopId, { q: "", filters: { vendor: ["Acme"] } });
    expect(r.fallback).toBeNull();
    expect(r.total).toBe(1);
    expect(r.products[0]?.vendor).toBe("Acme");
    // vendor facet excludes its own selection -> both vendors still counted.
    const vendorFacet = r.facets.find((f) => f.key === "vendor");
    expect(vendorFacet?.options.find((o) => o.value === "Acme")?.count).toBe(1);
    expect(vendorFacet?.options.find((o) => o.value === "Globex")?.count).toBe(1);
  });

  it("Phase 5 typo correction + synonym via the production Prisma path", async (ctx) => {
    if (!prismaOk) return ctx.skip();
    const shopId = await resolveShopId("shop-a.myshopify.com");

    await withShopExec(shopId, async (e) => {
      for (const [n, title] of [["300", "Wireless Headphones"], ["301", "Leather Couch"]] as const) {
        const { id } = await upsertProduct(e, shopId, {
          shopifyProductGid: `gid://shopify/Product/${n}`, title, status: "ACTIVE",
          onlineStoreUrl: `https://shop.test/${n}`,
        });
        await upsertVariant(e, shopId, id, { shopifyVariantGid: `gid://shopify/ProductVariant/${n}1`, sku: `P-${n}`, price: "20.00", availableForSale: true });
      }
    });
    const v = await withShopExec(shopId, (e) => createIndexVersion(e, shopId, "full", 2));
    await withShopExec(shopId, (e) => buildDocs(e, shopId, v.id));
    await withShopExec(shopId, (e) => validateIndexVersion(e, shopId, v.id, 2));
    await withShopExec(shopId, (e) => activateIndexVersion(e, shopId, v.id));
    await withShopExec(shopId, (e) => addSynonym(e, shopId, { kind: "two_way", terms: ["sofa", "couch"] }));

    // Typo correction (fuzzy) through real Prisma.
    const typo = await storefrontSearch(shopId, { q: "hedphones" });
    expect(typo.total).toBe(1);
    expect(typo.corrections[0]?.to).toBe("headphones");

    // Synonym expansion through real Prisma.
    const syn = await storefrontSearch(shopId, { q: "sofa" });
    expect(syn.products.map((p) => p.title)).toContain("Leather Couch");
  });

  it("Phase 6 NL parsing (brand + price) via the production Prisma path", async (ctx) => {
    if (!prismaOk) return ctx.skip();
    const shopId = await resolveShopId("shop-a.myshopify.com");

    await withShopExec(shopId, async (e) => {
      for (const [n, title, price] of [["400", "Nike Trail Shoe", "45.00"], ["401", "Nike Road Shoe", "90.00"]] as const) {
        const { id } = await upsertProduct(e, shopId, {
          shopifyProductGid: `gid://shopify/Product/${n}`, title, vendor: "Nike", productType: "Shoe",
          status: "ACTIVE", onlineStoreUrl: `https://shop.test/${n}`, productCreatedAt: "2024-05-01T00:00:00Z",
        });
        await upsertVariant(e, shopId, id, { shopifyVariantGid: `gid://shopify/ProductVariant/${n}1`, sku: `N-${n}`, price, availableForSale: true });
      }
    });
    const v = await withShopExec(shopId, (e) => createIndexVersion(e, shopId, "full", 2));
    await withShopExec(shopId, (e) => buildDocs(e, shopId, v.id));
    await withShopExec(shopId, (e) => validateIndexVersion(e, shopId, v.id, 2));
    await withShopExec(shopId, (e) => activateIndexVersion(e, shopId, v.id));

    const r = await storefrontSearch(shopId, { q: "Nike under 60" });
    expect(r.interpretedAs.applied).toBe(true);
    expect(r.appliedFilters.vendor).toContain("Nike");
    expect(r.appliedFilters.priceMax).toBe(60);
    expect(r.products.map((p) => p.title)).toEqual(["Nike Trail Shoe"]); // 45 only
  });

  it("claimWebhook + markWebhookProcessed via Prisma (idempotency)", async (ctx) => {
    if (!prismaOk) return ctx.skip();
    const shopId = await resolveShopId("shop-a.myshopify.com");
    const id = { webhookId: "wh-prisma-1", topic: "products/update", apiVersion: "2026-07", payloadHash: sha256Hex("{}") };
    const first = await claimWebhook(shopId, id);
    const dup = await claimWebhook(shopId, id);
    await markWebhookProcessed(shopId, "wh-prisma-1");
    expect(first).toBe(true);
    expect(dup).toBe(false);
  });
});
