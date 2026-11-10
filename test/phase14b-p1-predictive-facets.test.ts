import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type pg from "pg";
import type { Exec } from "~/lib/db/executor";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { predictiveWithExec } from "~/lib/search/predictive";

/*
 * Phase 14b P1 — predictive is products-only (never computes facet aggregates),
 * and the storefront path accepts an explicit products-only option whose product
 * output is byte-identical to the faceted path.
 *
 * FINDING (documented in PHASE14B_REPORT): predictive already did not compute
 * facets — it uses searchWithExec (product query + total only). The facet GROUP
 * BYs in the evidence come from the storefront search+facets cases. This test
 * LOCKS the guarantee: predictive issues zero facet statements, and the new
 * `facets:false` option returns identical products with the facet work skipped.
 */

// Signatures of the 5 facet aggregates in computeFacetsWithExec + price range.
const FACET_SQL = [/unnest\(psd\.tags\)/i, /GROUP BY available/i, /min\(price_min\)/i, /GROUP BY vendor\b/i, /GROUP BY product_type/i, /metafields->>/i];
const hasFacetSql = (sqls: string[]) => sqls.some((s) => FACET_SQL.some((re) => re.test(s)));

function recExec(client: pg.PoolClient): { exec: Exec; sqls: string[] } {
  const sqls: string[] = [];
  const exec: Exec = {
    rows: async <T>(sql: string, params: unknown[] = []) => { sqls.push(sql); return (await client.query(sql, params as unknown[])).rows as T[]; },
    run: async (sql: string, params: unknown[] = []) => { sqls.push(sql); return (await client.query(sql, params as unknown[])).rowCount ?? 0; },
  };
  return { exec, sqls };
}

const CATALOG = [
  { gid: "gid://shopify/Product/1", title: "Red Running Shoe", vendor: "Nike", type: "Shoe", tags: ["red", "sport"], price: "50.00", mat: "Leather" },
  { gid: "gid://shopify/Product/2", title: "Red Sandal", vendor: "Nike", type: "Sandal", tags: ["red"], price: "30.00", mat: "Rubber" },
  { gid: "gid://shopify/Product/3", title: "Blue Running Shoe", vendor: "Adidas", type: "Shoe", tags: ["blue", "sport"], price: "80.00", mat: "Leather" },
  { gid: "gid://shopify/Product/4", title: "Green Shoe", vendor: "Puma", type: "Shoe", tags: ["green"], price: "20.00", mat: "Canvas" },
];

describe("Phase 14b P1 — predictive skips facets; products-only option is byte-identical", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p14b-p1.myshopify.com");
    for (const s of CATALOG) {
      await db.withShopExec(shop, async (e) => {
        const { id } = await upsertProduct(e, shop, {
          shopifyProductGid: s.gid, title: s.title, handle: s.gid.split("/").pop(),
          vendor: s.vendor, productType: s.type, status: "ACTIVE", tags: s.tags,
          onlineStoreUrl: `https://shop.test/${s.title}`, featuredImageUrl: "https://img.test/x.jpg",
          featuredImageAlt: s.title, metafields: { "custom.material": s.mat },
        });
        await upsertVariant(e, shop, id, { shopifyVariantGid: s.gid + "/v1", sku: "SKU-" + s.gid.split("/").pop(), price: s.price, availableForSale: true, position: 1 });
      });
    }
    const n = CATALOG.length;
    const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  });

  it("predictiveWithExec issues NO facet aggregate statements", async () => {
    const { sqls } = await db.withShopClient(shop, async (client) => {
      const { exec, sqls } = recExec(client);
      await predictiveWithExec(exec, shop, { q: "shoe" });
      return { sqls };
    });
    expect(hasFacetSql(sqls), "predictive must not run any facet GROUP BY").toBe(false);
  });

  it("predictive products equal the storefront products for the same query (item-by-item)", async () => {
    const pred = await db.withShopExec(shop, (e) => predictiveWithExec(e, shop, { q: "shoe", limit: 24 }));
    const sf = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "shoe", nl: false, limit: 24, offset: 0 }));
    expect(pred.products.map((p) => p.id)).toEqual(sf.products.map((p) => p.id));
    expect(pred.products).toEqual(sf.products);
  });

  it("facets:false returns byte-identical products/total/order and skips the facet statements", async () => {
    const withF = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "shoe", nl: false, limit: 24, offset: 0 }));
    const { res: withoutF, sqls } = await db.withShopClient(shop, async (client) => {
      const { exec, sqls } = recExec(client);
      const res = await storefrontSearchWithExec(exec, shop, { q: "shoe", nl: false, limit: 24, offset: 0, facets: false });
      return { res, sqls };
    });
    expect(withoutF.products).toEqual(withF.products);
    expect(withoutF.total).toEqual(withF.total);
    expect(withoutF.strategy).toEqual(withF.strategy);
    expect(withoutF.facets).toEqual([]);
    expect(withoutF.priceRange).toBeNull();
    expect(withF.facets.length).toBeGreaterThan(0); // the default path DID compute them
    expect(hasFacetSql(sqls), "facets:false must skip facet statements").toBe(false);
  });
});
