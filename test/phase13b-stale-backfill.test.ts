import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
  backfillActiveSearchColumns,
} from "~/lib/index/engine";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { saveCombinedMode, countStaleCombinedDocs } from "~/lib/search/combined";

/*
 * Phase 13b C4 — legacy docs built before Phase 13 have a NULL combined_role
 * column, so a non-default hide mode would silently fail to hide them. The admin
 * surfaces the stale count and enqueues a bounded backfill (backfillActive-
 * SearchColumns) that re-projects the docs. This exercises the DB-level pieces.
 */
const G = (n: number) => `gid://shopify/Product/${n}`;
const h = (g: string) => g.split("/").pop()!;
const P = G(1), C1 = G(2), C2 = G(3), PLAIN = G(4);

async function seed(db: TestDb, shop: string, g: string, title: string, role: "PARENT" | "CHILD" | null, parent: string | null, price: string) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: g, title, handle: h(g), status: "ACTIVE",
      onlineStoreUrl: `https://shop.example/products/${h(g)}`, metafields: {},
      productCreatedAt: "2024-01-01T00:00:00Z", shopifyUpdatedAt: "2024-01-01T00:00:00Z",
      combinedRole: role, combinedParentGid: parent,
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: g + "/v", price, availableForSale: true });
  });
}
async function build(db: TestDb, shop: string) {
  const n = await db.withShopExec(shop, async (e) =>
    (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
}
// Simulate legacy docs: null out the denormalised combined_role column (as if
// the doc was built before migration 0018), leaving the product rows intact.
async function makeDocsLegacy(db: TestDb, shop: string) {
  await db.withShopExec(shop, (e) => e.run(
    `UPDATE product_search_doc d SET combined_role = NULL
     FROM index_version iv WHERE iv.id = d.index_version_id AND iv.status='active' AND d.shop_id=$1::uuid`, [shop]));
}
const titles = (r: { products: { title: string | null }[] }) => r.products.map((p) => p.title);

describe("Phase 13b C4 — stale legacy docs + backfill", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p13bc4.myshopify.com");
    await seed(db, shop, P, "Parent Tee", "PARENT", null, "999.00");
    await seed(db, shop, C1, "Child Tee A", "CHILD", P, "10.00");
    await seed(db, shop, C2, "Child Tee B", "CHILD", P, "30.00");
    await seed(db, shop, PLAIN, "Plain Mug", null, null, "5.00");
    await build(db, shop);
    await makeDocsLegacy(db, shop);
  });

  it("legacy docs are detected: countStaleCombinedDocs = 3 (parent + 2 children)", async () => {
    const n = await db.withShopExec(shop, (e) => countStaleCombinedDocs(e, shop));
    expect(n).toBe(3);
  });

  it("the bug: with hide_children, legacy children are STILL visible (leak)", async () => {
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "hide_children"));
    const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "Tee", nl: false, limit: 20, offset: 0 }));
    expect(titles(r)).toEqual(expect.arrayContaining(["Child Tee A", "Child Tee B"])); // not yet hidden
  });

  it("after backfill: stale count is 0 and hide_children now hides the children", async () => {
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "hide_children"));
    const fixed = await db.withShopExec(shop, (e) => backfillActiveSearchColumns(e, shop));
    expect(fixed).toBeGreaterThan(0);
    expect(await db.withShopExec(shop, (e) => countStaleCombinedDocs(e, shop))).toBe(0);
    const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "Tee", nl: false, limit: 20, offset: 0 }));
    expect(titles(r)).toEqual(["Parent Tee"]); // children hidden now
  });

  it("show_all is unaffected by legacy docs (nothing hidden either way)", async () => {
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "show_all"));
    const r = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "Tee", nl: false, limit: 20, offset: 0 }));
    expect(r.total).toBe(3);
  });

  it("countStaleCombinedDocs is tenant-isolated", async () => {
    const other = await db.resolveShop("p13bc4b.myshopify.com");
    expect(await db.withShopExec(other, (e) => countStaleCombinedDocs(e, other))).toBe(0);
  });

  it("a shop with no active version → 0 (no throw)", async () => {
    const fresh = await db.resolveShop("p13bc4c.myshopify.com");
    expect(await db.withShopExec(fresh, (e) => countStaleCombinedDocs(e, fresh))).toBe(0);
  });
});
