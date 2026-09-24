import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion,
  buildDocs,
  validateIndexVersion,
  activateIndexVersion,
  rollbackToVersion,
  getActiveVersion,
  recoverInterruptedBuilds,
} from "~/lib/index/engine";

async function seedProducts(db: TestDb, shopId: string, n: number) {
  await db.withShopExec(shopId, async (e) => {
    for (let i = 1; i <= n; i++) {
      const { id: pid } = await upsertProduct(e, shopId, {
        shopifyProductGid: `gid://shopify/Product/${i}`,
        title: `Product ${i}`,
        vendor: "Acme",
        tags: ["tag" + i],
      });
      await upsertVariant(e, shopId, pid, {
        shopifyVariantGid: `gid://shopify/ProductVariant/${i}0`,
        sku: `SKU-${i}`,
      });
    }
  });
}

/** Build+validate+activate a fresh version in one flow; returns the version id. */
async function buildAndActivate(db: TestDb, shopId: string, expected: number | null = null) {
  const v = await db.withShopExec(shopId, (e) => createIndexVersion(e, shopId, "full", expected));
  await db.withShopExec(shopId, (e) => buildDocs(e, shopId, v.id));
  const res = await db.withShopExec(shopId, (e) =>
    validateIndexVersion(e, shopId, v.id, expected),
  );
  expect(res.pass).toBe(true);
  await db.withShopExec(shopId, (e) => activateIndexVersion(e, shopId, v.id));
  return v.id;
}

describe("versioned index: build -> validate -> swap -> rollback", () => {
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

  it("builds documents and validates a full index", async () => {
    await seedProducts(db, shopA, 3);
    const v = await db.withShopExec(shopA, (e) => createIndexVersion(e, shopA, "full", 3));
    const docCount = await db.withShopExec(shopA, (e) => buildDocs(e, shopA, v.id));
    expect(docCount).toBe(3);
    const res = await db.withShopExec(shopA, (e) => validateIndexVersion(e, shopA, v.id, 3));
    expect(res).toMatchObject({ pass: true, dbCount: 3, indexedCount: 3, failedCount: 0 });
    // doc content includes denormalised variant + tags
    const doc = await db.withShopExec(shopA, (e) =>
      e.rows<{ search_text: string }>(
        "SELECT search_text FROM product_search_doc WHERE shop_id=$1 AND index_version_id=$2 ORDER BY search_text LIMIT 1",
        [shopA, v.id],
      ),
    );
    expect(doc[0].search_text).toMatch(/SKU-/);
  });

  it("a partially built version is never the active index", async () => {
    await seedProducts(db, shopA, 2);
    const v = await db.withShopExec(shopA, (e) => createIndexVersion(e, shopA, "full"));
    // build started but NOT validated/activated
    await db.withShopExec(shopA, (e) => buildDocs(e, shopA, v.id));
    const active = await db.withShopExec(shopA, (e) => getActiveVersion(e, shopA));
    expect(active).toBeNull();
  });

  it("atomic swap keeps exactly one active version", async () => {
    await seedProducts(db, shopA, 2);
    const v1 = await buildAndActivate(db, shopA);
    const a1 = await db.withShopExec(shopA, (e) => getActiveVersion(e, shopA));
    expect(a1?.id).toBe(v1);

    // build a second version and activate -> v1 superseded, v2 active
    const v2 = await buildAndActivate(db, shopA);
    const activeRows = await db.withShopExec(shopA, (e) =>
      e.rows<{ n: number }>("SELECT count(*)::int n FROM index_version WHERE shop_id=$1 AND status='active'", [shopA]),
    );
    expect(activeRows[0].n).toBe(1);
    const a2 = await db.withShopExec(shopA, (e) => getActiveVersion(e, shopA));
    expect(a2?.id).toBe(v2);
    expect(a2?.version).toBe(2);
  });

  it("the DB rejects two active versions (partial unique index)", async () => {
    await seedProducts(db, shopA, 1);
    await buildAndActivate(db, shopA); // v1 active
    // Build v2 to 'validated' but force a raw second activation without demoting v1.
    const v2 = await db.withShopExec(shopA, (e) => createIndexVersion(e, shopA, "full"));
    await db.withShopExec(shopA, (e) => buildDocs(e, shopA, v2.id));
    await db.withShopExec(shopA, (e) => validateIndexVersion(e, shopA, v2.id));
    await expect(
      db.withShopExec(shopA, (e) =>
        e.run("UPDATE index_version SET status='active' WHERE shop_id=$1 AND id=$2", [shopA, v2.id]),
      ),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("activate refuses a non-validated version", async () => {
    await seedProducts(db, shopA, 1);
    const v = await db.withShopExec(shopA, (e) => createIndexVersion(e, shopA, "full"));
    await expect(
      db.withShopExec(shopA, (e) => activateIndexVersion(e, shopA, v.id)),
    ).rejects.toThrow(/not in 'validated'/);
  });

  it("validation fails when docs are missing (integrity check)", async () => {
    await seedProducts(db, shopA, 3);
    const v = await db.withShopExec(shopA, (e) => createIndexVersion(e, shopA, "full"));
    // deliberately do NOT build docs -> indexed 0 of 3
    const res = await db.withShopExec(shopA, (e) => validateIndexVersion(e, shopA, v.id, 3));
    expect(res.pass).toBe(false);
    expect(res.failedCount).toBe(3);
    const status = await db.withShopExec(shopA, (e) =>
      e.rows<{ status: string }>("SELECT status FROM index_version WHERE id=$1", [v.id]),
    );
    expect(status[0].status).toBe("failed");
  });

  it("rollback restores a previous version and keeps one active", async () => {
    await seedProducts(db, shopA, 2);
    const v1 = await buildAndActivate(db, shopA); // active v1
    const v2 = await buildAndActivate(db, shopA); // active v2, v1 superseded

    await db.withShopExec(shopA, (e) => rollbackToVersion(e, shopA, v1));
    const active = await db.withShopExec(shopA, (e) => getActiveVersion(e, shopA));
    expect(active?.id).toBe(v1);
    const counts = await db.withShopExec(shopA, (e) =>
      e.rows<{ n: number }>("SELECT count(*)::int n FROM index_version WHERE shop_id=$1 AND status='active'", [shopA]),
    );
    expect(counts[0].n).toBe(1);
    // v2 is now rolled_back
    const v2status = await db.withShopExec(shopA, (e) =>
      e.rows<{ status: string }>("SELECT status FROM index_version WHERE id=$1", [v2]),
    );
    expect(v2status[0].status).toBe("rolled_back");
  });

  it("recovers interrupted builds without touching the active index", async () => {
    await seedProducts(db, shopA, 2);
    const v1 = await buildAndActivate(db, shopA); // active
    // simulate an interrupted build: create + partial build, leave 'validating'
    const v2 = await db.withShopExec(shopA, (e) => createIndexVersion(e, shopA, "full"));
    await db.withShopExec(shopA, (e) => buildDocs(e, shopA, v2.id)); // now 'validating'

    const recovered = await db.withShopExec(shopA, (e) => recoverInterruptedBuilds(e, shopA));
    expect(recovered).toBe(1);
    // active is still v1
    const active = await db.withShopExec(shopA, (e) => getActiveVersion(e, shopA));
    expect(active?.id).toBe(v1);
    // v2 marked failed, its docs removed
    const v2row = await db.withShopExec(shopA, (e) =>
      e.rows<{ status: string; docs: number }>(
        "SELECT iv.status, (SELECT count(*)::int FROM product_search_doc d WHERE d.index_version_id=iv.id) AS docs FROM index_version iv WHERE iv.id=$1",
        [v2.id],
      ),
    );
    expect(v2row[0].status).toBe("failed");
    expect(Number(v2row[0].docs)).toBe(0);
  });
});
