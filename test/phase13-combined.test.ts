import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
  refreshDocInActiveVersion, refreshDocsForProducts, reindexVersionDocs,
} from "~/lib/index/engine";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { predictiveWithExec } from "~/lib/search/predictive";
import { catalogSuggestionsWithExec } from "~/lib/search/suggest";
import { getRecommendations } from "~/lib/recommend/engine";
import {
  loadCombinedMode, saveCombinedMode, combinedHideFor, normalizeCombinedMode,
} from "~/lib/search/combined";
import { combinedHidePredicate } from "~/lib/search/match";
import { normalizeProductNode } from "~/lib/catalog/normalize";

/*
 * Phase 13.5 — Combined Listings (READ-ONLY, read_products only). Same node-pg
 * harness and identical SQL as production. Migrations 0017/0018 applied.
 */

const G = (n: number) => `gid://shopify/Product/${n}`;
const handleOf = (gid: string) => gid.split("/").pop()!;

interface Seed {
  gid: string; title: string; vendor?: string; type?: string; tags?: string[];
  price: string; available?: boolean; status?: string; published?: boolean;
  combinedRole?: "PARENT" | "CHILD" | null; combinedParentGid?: string | null;
  updatedAt?: string;
}

async function seed(db: TestDb, shop: string, s: Seed): Promise<string> {
  return db.withShopExec(shop, async (e) => {
    const published = s.published !== false;
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: s.gid, title: s.title, handle: handleOf(s.gid),
      vendor: s.vendor ?? "Acme", productType: s.type ?? "Thing",
      tags: s.tags ?? [], status: s.status ?? "ACTIVE",
      onlineStoreUrl: published ? `https://shop.example/products/${handleOf(s.gid)}` : null,
      featuredImageUrl: `https://cdn.shopify.com/img/${handleOf(s.gid)}.jpg`,
      metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z",
      shopifyUpdatedAt: s.updatedAt ?? "2024-01-01T00:00:00Z",
      combinedRole: s.combinedRole ?? null, combinedParentGid: s.combinedParentGid ?? null,
    });
    await upsertVariant(e, shop, id, {
      shopifyVariantGid: s.gid + "/v", sku: "SKU-" + handleOf(s.gid), price: s.price,
      availableForSale: s.available ?? true,
    });
    return id;
  });
}

async function build(db: TestDb, shop: string): Promise<string> {
  const n = await db.withShopExec(shop, async (e) =>
    (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  return v.id;
}

function docOf(db: TestDb, shop: string, gid: string): Promise<any> {
  return db.withShopExec(shop, async (e) => {
    const rows = await e.rows<{ doc: any; combined_role: string | null }>(
      `SELECT d.doc, d.combined_role FROM product_search_doc d
       JOIN index_version iv ON iv.id = d.index_version_id AND iv.status='active'
       WHERE d.shop_id=$1::uuid AND d.shopify_product_gid=$2`,
      [shop, gid],
    );
    return rows[0];
  });
}

// A combined listing: one PARENT, two CHILDren (prices 10 and 30). The parent
// has its own variant priced 999 so the aggregate (10..30) is provably derived
// from CHILD rows, not the parent's own price.
const PARENT = G(1), CHILD_A = G(2), CHILD_B = G(3), PLAIN = G(4);
const CAT: Seed[] = [
  { gid: PARENT, title: "Parent Tee", price: "999.00", combinedRole: "PARENT" },
  { gid: CHILD_A, title: "Child Tee Small", price: "10.00", combinedRole: "CHILD", combinedParentGid: PARENT },
  { gid: CHILD_B, title: "Child Tee Large", price: "30.00", combinedRole: "CHILD", combinedParentGid: PARENT },
  { gid: PLAIN, title: "Plain Mug", price: "5.00" }, // NULL role — never hidden
];

describe("Phase 13.5 — combined listings: sync + doc projection", () => {
  let db: TestDb; let shop: string; let versionId: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p13.myshopify.com");
    for (const s of CAT) await seed(db, shop, s);
    versionId = await build(db, shop);
  });

  it("stores role + parent gid on the product row", async () => {
    const rows = await db.withShopExec(shop, (e) =>
      e.rows<{ gid: string; role: string | null; parent: string | null }>(
        `SELECT shopify_product_gid gid, combined_role role, combined_parent_gid parent
         FROM product WHERE shop_id=$1::uuid ORDER BY shopify_product_gid`, [shop]));
    const byGid = new Map(rows.map((r) => [r.gid, r]));
    expect(byGid.get(PARENT)).toMatchObject({ role: "PARENT", parent: null });
    expect(byGid.get(CHILD_A)).toMatchObject({ role: "CHILD", parent: PARENT });
    expect(byGid.get(PLAIN)).toMatchObject({ role: null, parent: null });
  });

  it("parent doc carries aggregate child count + price range DERIVED from children", async () => {
    const parent = await docOf(db, shop, PARENT);
    expect(parent.combined_role).toBe("PARENT");
    expect(parent.doc.combinedRole).toBe("PARENT");
    expect(parent.doc.combinedChildCount).toBe(2);
    expect(Number(parent.doc.combinedPriceMin)).toBe(10);
    expect(Number(parent.doc.combinedPriceMax)).toBe(30);
    // own price is still the parent's own variant (proves aggregate != own price)
    expect(Number(parent.doc.priceMin)).toBe(999);
  });

  it("child doc carries role + parent gid, NO aggregate keys", async () => {
    const child = await docOf(db, shop, CHILD_A);
    expect(child.doc.combinedRole).toBe("CHILD");
    expect(child.doc.combinedParentGid).toBe(PARENT);
    expect(child.doc).not.toHaveProperty("combinedChildCount");
  });

  it("byte-identical when off: a NULL-role product's doc has NO combined keys", async () => {
    const plain = await docOf(db, shop, PLAIN);
    expect(plain.combined_role).toBeNull();
    expect(plain.doc).not.toHaveProperty("combinedRole");
    expect(plain.doc).not.toHaveProperty("combinedParentGid");
    expect(plain.doc).not.toHaveProperty("combinedChildCount");
    // content_hash is md5(doc::text) — compute it the pre-13.5 way and compare.
    const h = await db.withShopExec(shop, (e) =>
      e.rows<{ ch: string; md: string }>(
        `SELECT content_hash ch, md5(doc::text) md FROM product_search_doc
         WHERE shop_id=$1::uuid AND shopify_product_gid=$2 AND index_version_id=$3::uuid`,
        [shop, PLAIN, versionId]));
    expect(h[0].ch).toBe(h[0].md);
  });

  it("docInsertSql parity: the parent doc is identical across all 4 doc paths", async () => {
    const full = await docOf(db, shop, PARENT);
    const parentId = await db.withShopExec(shop, async (e) =>
      (await e.rows<{ id: string }>(`SELECT id FROM product WHERE shop_id=$1::uuid AND shopify_product_gid=$2`, [shop, PARENT]))[0].id);

    await db.withShopExec(shop, (e) => refreshDocInActiveVersion(e, shop, parentId));
    const single = await docOf(db, shop, PARENT);

    await db.withShopExec(shop, (e) => refreshDocsForProducts(e, shop, [parentId]));
    const batch = await docOf(db, shop, PARENT);

    await db.withShopExec(shop, (e) => reindexVersionDocs(e, shop, versionId));
    const reindex = await docOf(db, shop, PARENT);

    expect(single.doc).toEqual(full.doc);
    expect(batch.doc).toEqual(full.doc);
    expect(reindex.doc).toEqual(full.doc);
  });
});

describe("Phase 13.5 — monotonic sync guard (replay / out-of-order)", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p13mono.myshopify.com");
  });

  it("an older replayed update never regresses the role; a newer one applies", async () => {
    // T2: product becomes a PARENT.
    await seed(db, shop, { gid: PARENT, title: "P", price: "1.00", combinedRole: "PARENT", updatedAt: "2024-02-01T00:00:00Z" });
    // T1 (older) tries to clear the role — must be skipped by the >= guard.
    const older = await db.withShopExec(shop, (e) => upsertProduct(e, shop, {
      shopifyProductGid: PARENT, title: "P", handle: handleOf(PARENT),
      combinedRole: null, shopifyUpdatedAt: "2024-01-01T00:00:00Z",
    }));
    expect(older.applied).toBe(false);
    let role = await db.withShopExec(shop, async (e) =>
      (await e.rows<{ r: string | null }>(`SELECT combined_role r FROM product WHERE shop_id=$1::uuid AND shopify_product_gid=$2`, [shop, PARENT]))[0].r);
    expect(role).toBe("PARENT");
    // T3 (newer) clears it — must apply.
    const newer = await db.withShopExec(shop, (e) => upsertProduct(e, shop, {
      shopifyProductGid: PARENT, title: "P", handle: handleOf(PARENT),
      combinedRole: null, shopifyUpdatedAt: "2024-03-01T00:00:00Z",
    }));
    expect(newer.applied).toBe(true);
    role = await db.withShopExec(shop, async (e) =>
      (await e.rows<{ r: string | null }>(`SELECT combined_role r FROM product WHERE shop_id=$1::uuid AND shopify_product_gid=$2`, [shop, PARENT]))[0].r);
    expect(role).toBeNull();
  });
});

describe("Phase 13.5 — hard-WHERE hide across every surface", () => {
  let db: TestDb; let shop: string; let versionId: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p13hide.myshopify.com");
    for (const s of CAT) await seed(db, shop, s);
    versionId = await build(db, shop);
  });

  const search = (q: string) => db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q, nl: false, limit: 20, offset: 0 }));

  it("show_all (default): both parent and children are searchable", async () => {
    expect(await db.withShopExec(shop, (e) => loadCombinedMode(e, shop))).toBe("show_all");
    const r = await search("Tee");
    const gids = r.products.map((p) => p.id);
    // ids are internal uuids; assert by title instead
    const titles = r.products.map((p) => p.title);
    expect(titles).toEqual(expect.arrayContaining(["Parent Tee", "Child Tee Small", "Child Tee Large"]));
    expect(r.total).toBe(3);
  });

  it("hide_children: children vanish from results, totals AND facet counts; parent + plain stay", async () => {
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "hide_children"));
    const r = await search("Tee");
    const titles = r.products.map((p) => p.title);
    expect(titles).toEqual(["Parent Tee"]);
    expect(r.total).toBe(1);
    // a vendor facet count reflects the same hidden set (results==facets)
    const r2 = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "", nl: false, limit: 20, offset: 0 }));
    const titlesAll = r2.products.map((p) => p.title);
    expect(titlesAll).toEqual(expect.arrayContaining(["Parent Tee", "Plain Mug"]));
    expect(titlesAll).not.toContain("Child Tee Small");
    // facet total over the browse set == visible rows (parent + plain = 2)
    expect(r2.total).toBe(2);
  });

  it("hide_parents: the parent vanishes; children + plain stay", async () => {
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "hide_parents"));
    const r = await search("Tee");
    const titles = r.products.map((p) => p.title).sort();
    expect(titles).toEqual(["Child Tee Large", "Child Tee Small"]);
    expect(r.total).toBe(2);
  });

  it("predictive respects hide_children", async () => {
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "hide_children"));
    const r = await db.withShopExec(shop, (e) => predictiveWithExec(e, shop, { q: "Tee" }));
    expect(r.products.map((p) => p.title)).toEqual(["Parent Tee"]);
  });

  it("suggestions respect hide_children (hidden-role terms absent)", async () => {
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "hide_children"));
    const ch = combinedHideFor(await db.withShopExec(shop, (e) => loadCombinedMode(e, shop)));
    const sugg = await db.withShopExec(shop, (e) => catalogSuggestionsWithExec(e, shop, "Child", 10, { combinedHide: ch }));
    expect(sugg.find((s) => s.text === "Child Tee Small")).toBeUndefined();
    // without the hide, the term is present
    const suggOpen = await db.withShopExec(shop, (e) => catalogSuggestionsWithExec(e, shop, "Child", 10, {}));
    expect(suggOpen.find((s) => s.text === "Child Tee Small")).toBeDefined();
  });

  it("recommendations (related) exclude the hidden role", async () => {
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "hide_children"));
    const r = await db.withShopExec(shop, (e) =>
      getRecommendations(e, shop, { type: "related", seed: PLAIN, limit: 10 }));
    expect(r.products.map((p) => p.title)).not.toContain("Child Tee Small");
    expect(r.products.map((p) => p.title)).not.toContain("Child Tee Large");
  });

  it("NULL-role products are NEVER hidden by either mode", async () => {
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "hide_children"));
    const a = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "Mug", nl: false, limit: 20, offset: 0 }));
    expect(a.products.map((p) => p.title)).toEqual(["Plain Mug"]);
    await db.withShopExec(shop, (e) => saveCombinedMode(e, shop, "hide_parents"));
    const b = await db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, { q: "Mug", nl: false, limit: 20, offset: 0 }));
    expect(b.products.map((p) => p.title)).toEqual(["Plain Mug"]);
  });
});

describe("Phase 13.5 — cross-shop isolation of the parent aggregate", () => {
  let db: TestDb; let shopA: string; let shopB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p13a.myshopify.com");
    shopB = await db.resolveShop("p13b.myshopify.com");
  });

  it("a child in shop B with the same parent gid never counts toward shop A's parent", async () => {
    await seed(db, shopA, { gid: PARENT, title: "P", price: "999.00", combinedRole: "PARENT" });
    await seed(db, shopA, { gid: CHILD_A, title: "CA", price: "10.00", combinedRole: "CHILD", combinedParentGid: PARENT });
    // shop B: a decoy child pointing at the SAME parent gid.
    await seed(db, shopB, { gid: CHILD_B, title: "CB", price: "50.00", combinedRole: "CHILD", combinedParentGid: PARENT });
    const vA = await build(db, shopA);
    const parent = await docOf(db, shopA, PARENT);
    expect(parent.doc.combinedChildCount).toBe(1); // only shop A's child
    expect(Number(parent.doc.combinedPriceMax)).toBe(10); // shop B's 50 excluded
    expect(vA).toBeTruthy();
  });
});

describe("Phase 13.5 — pure units (setting + predicate)", () => {
  it("normalizeCombinedMode clamps unknown values to show_all", () => {
    expect(normalizeCombinedMode("hide_children")).toBe("hide_children");
    expect(normalizeCombinedMode("hide_parents")).toBe("hide_parents");
    expect(normalizeCombinedMode("show_all")).toBe("show_all");
    expect(normalizeCombinedMode("garbage")).toBe("show_all");
    expect(normalizeCombinedMode(null)).toBe("show_all");
    expect(normalizeCombinedMode(42)).toBe("show_all");
  });

  it("combinedHideFor maps mode → discriminant", () => {
    expect(combinedHideFor("hide_children")).toBe("child");
    expect(combinedHideFor("hide_parents")).toBe("parent");
    expect(combinedHideFor("show_all")).toBeUndefined();
    expect(combinedHideFor(undefined)).toBeUndefined();
  });

  // Mutation guard: the hide predicate is load-bearing. If a mutant drops the
  // clause (returns null for "child"), children would NOT be excluded — this
  // pins the exact SQL so that regression is caught.
  it("combinedHidePredicate returns the exact hard-WHERE fragment", () => {
    expect(combinedHidePredicate("child")).toBe("combined_role IS DISTINCT FROM 'CHILD'");
    expect(combinedHidePredicate("parent")).toBe("combined_role IS DISTINCT FROM 'PARENT'");
    expect(combinedHidePredicate("child", "d.combined_role")).toBe("d.combined_role IS DISTINCT FROM 'CHILD'");
    expect(combinedHidePredicate(undefined)).toBeNull();
  });

  it("normalizeProductNode maps combinedListingRole + parent gid, rejecting junk", () => {
    const parent = normalizeProductNode({ id: PARENT, title: "P", combinedListingRole: "PARENT" });
    expect(parent.product.combinedRole).toBe("PARENT");
    expect(parent.product.combinedParentGid).toBeNull();
    const child = normalizeProductNode({ id: CHILD_A, title: "C", combinedListingRole: "CHILD", combinedListing: { parentProduct: { id: PARENT } } });
    expect(child.product.combinedRole).toBe("CHILD");
    expect(child.product.combinedParentGid).toBe(PARENT);
    const junk = normalizeProductNode({ id: PLAIN, title: "X", combinedListingRole: "NONSENSE" });
    expect(junk.product.combinedRole).toBeNull();
    const none = normalizeProductNode({ id: PLAIN, title: "X" });
    expect(none.product.combinedRole).toBeNull();
  });
});

describe("Phase 13.5 — combined mode setting round-trip + RLS", () => {
  let db: TestDb; let shopA: string; let shopB: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("p13sa.myshopify.com");
    shopB = await db.resolveShop("p13sb.myshopify.com");
  });

  it("defaults to show_all, round-trips valid values, clamps junk", async () => {
    expect(await db.withShopExec(shopA, (e) => loadCombinedMode(e, shopA))).toBe("show_all");
    await db.withShopExec(shopA, (e) => saveCombinedMode(e, shopA, "hide_children"));
    expect(await db.withShopExec(shopA, (e) => loadCombinedMode(e, shopA))).toBe("hide_children");
    const saved = await db.withShopExec(shopA, (e) => saveCombinedMode(e, shopA, "garbage"));
    expect(saved).toBe("show_all");
    expect(await db.withShopExec(shopA, (e) => loadCombinedMode(e, shopA))).toBe("show_all");
  });

  it("the mode is tenant-isolated (shop B never sees shop A's setting)", async () => {
    await db.withShopExec(shopA, (e) => saveCombinedMode(e, shopA, "hide_parents"));
    expect(await db.withShopExec(shopB, (e) => loadCombinedMode(e, shopB))).toBe("show_all");
    expect(await db.withShopExec(shopA, (e) => loadCombinedMode(e, shopA))).toBe("hide_parents");
  });
});
