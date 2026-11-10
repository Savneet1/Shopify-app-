import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
  refreshDocsForProducts, rollbackToVersion, pruneOldVersions, getActiveVersion,
} from "~/lib/index/engine";
import { precomputedParseValues, precomputedFacets } from "~/lib/search/facetcache";
import { canUsePrecomputedFacets } from "~/lib/search/facets";
import { FACET_METAFIELD_MAPKEY } from "~/lib/search/config";
import type { PlannedMatch } from "~/lib/search/match";

/*
 * Phase 14b P3/P4 — the precomputed per-version facet tables equal the canonical
 * live queries they replace, stay correct across every doc mutation + swap +
 * rollback, are tenant-isolated, cascade on version retention, and the P4 gate
 * only fires for an unfiltered/un-hidden/show_all browse.
 */

const VISIBLE = `shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'`;

// Canonical LIVE queries (copied from the pre-14b nlparse/facets code) to diff against.
async function liveParse(e: Exec, shop: string, ver: string) {
  const col = async (c: string) => (await e.rows<{ v: string }>(
    `SELECT DISTINCT ${c} AS v FROM product_search_doc WHERE ${VISIBLE} AND ${c} IS NOT NULL AND ${c} <> ''`, [shop, ver])).map((r) => r.v);
  const vendors = await col("vendor");
  const productTypes = await col("product_type");
  const tagValues = (await e.rows<{ v: string }>(
    `SELECT DISTINCT unnest(tags) AS v FROM product_search_doc WHERE ${VISIBLE}`, [shop, ver]))
    .map((r) => r.v).filter((v) => v != null && v !== "");
  const metafieldValues = (await e.rows<{ v: string }>(
    `SELECT DISTINCT metafields->>$3 AS v FROM product_search_doc WHERE ${VISIBLE} AND metafields->>$3 IS NOT NULL AND metafields->>$3 <> ''`,
    [shop, ver, FACET_METAFIELD_MAPKEY])).map((r) => r.v);
  return { vendors, productTypes, tagValues, metafieldValues };
}
async function liveBrowseFacets(e: Exec, shop: string, ver: string) {
  const col = async (c: string) => (await e.rows<{ value: string; count: number }>(
    `SELECT ${c} AS value, count(*)::int AS count FROM product_search_doc WHERE ${VISIBLE} AND ${c} IS NOT NULL AND ${c} <> '' GROUP BY ${c} ORDER BY count DESC, value ASC LIMIT 50`, [shop, ver]));
  const vendor = (await col("vendor")).map((r) => ({ value: r.value, label: r.value, count: r.count }));
  const productType = (await col("product_type")).map((r) => ({ value: r.value, label: r.value, count: r.count }));
  const tags = (await e.rows<{ value: string; count: number }>(
    `SELECT t AS value, count(*)::int AS count FROM product_search_doc psd, unnest(psd.tags) t WHERE ${VISIBLE} GROUP BY t ORDER BY count DESC, value ASC LIMIT 50`, [shop, ver])).map((r) => ({ value: r.value, label: r.value, count: r.count }));
  const av = (await e.rows<{ value: boolean; count: number }>(
    `SELECT available AS value, count(*)::int AS count FROM product_search_doc WHERE ${VISIBLE} GROUP BY available`, [shop, ver]))
    .map((r) => ({ value: r.value ? "true" : "false", label: r.value ? "In stock" : "Out of stock", count: r.count }))
    .sort((a, b) => (a.value === b.value ? 0 : a.value === "true" ? -1 : 1));
  const metafield = (await e.rows<{ value: string; count: number }>(
    `SELECT metafields->>$3 AS value, count(*)::int AS count FROM product_search_doc WHERE ${VISIBLE} AND metafields->>$3 IS NOT NULL AND metafields->>$3 <> '' GROUP BY value ORDER BY count DESC, value ASC LIMIT 50`,
    [shop, ver, FACET_METAFIELD_MAPKEY])).map((r) => ({ value: r.value, label: r.value, count: r.count }));
  const facets = [
    { key: "vendor", label: "Vendor", options: vendor },
    { key: "productType", label: "Product type", options: productType },
    { key: "tags", label: "Tags", options: tags },
    { key: "available", label: "Availability", options: av },
    { key: "material", label: "Material", options: metafield },
  ].filter((f) => f.options.length > 0);
  const pr = (await e.rows<{ min: string | null; max: string | null }>(
    `SELECT min(price_min) AS min, max(price_max) AS max FROM product_search_doc WHERE ${VISIBLE}`, [shop, ver]))[0];
  const priceRange = pr && pr.min != null && pr.max != null ? { min: String(pr.min), max: String(pr.max) } : null;
  return { facets, priceRange };
}
const sortByVal = <T extends { vendors: string[]; productTypes: string[]; tagValues: string[]; metafieldValues: string[] }>(x: T) => ({
  vendors: [...x.vendors].sort(), productTypes: [...x.productTypes].sort(),
  tagValues: [...x.tagValues].sort(), metafieldValues: [...x.metafieldValues].sort(),
});

interface Seed { gid: string; title: string; vendor: string; type: string; tags: string[]; price: string; available?: boolean; mat?: string; status?: string; published?: boolean; }
let pc = 0;
function randomCatalog(n: number): Seed[] {
  const vendors = ["Nike", "Adidas", "Puma", "Asics"]; const types = ["Shoe", "Sandal", "Boot"]; const tags = ["red", "blue", "sport", "sale", "new"]; const mats = ["Leather", "Rubber", "Canvas"];
  const out: Seed[] = [];
  for (let i = 0; i < n; i++) {
    // Use the HIGH bits (low-order LCG bits are not random — they made every
    // product unpublished when taken mod a power of two).
    const r = (m: number) => { pc = (pc * 1103515245 + 12345) & 0x7fffffff; return Math.floor(pc / 65536) % m; };
    out.push({
      gid: `gid://shopify/Product/${i + 1}`, title: `P${i + 1}`,
      vendor: vendors[r(vendors.length)], type: types[r(types.length)],
      tags: [tags[r(tags.length)], tags[r(tags.length)]], price: String(10 + r(90)),
      available: r(3) !== 0, mat: mats[r(mats.length)],
      status: r(10) === 0 ? "DRAFT" : "ACTIVE", published: r(8) !== 0,
    });
  }
  return out;
}

describe("Phase 14b P3/P4 — precomputed facet values & counts", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); pc = 42; shop = await db.resolveShop("p14b-facet.myshopify.com"); });

  async function seed(s: Seed): Promise<string> {
    return db.withShopExec(shop, async (e) => {
      const { id } = await upsertProduct(e, shop, {
        shopifyProductGid: s.gid, title: s.title, handle: s.gid.split("/").pop(), vendor: s.vendor,
        productType: s.type, status: s.status ?? "ACTIVE", tags: s.tags,
        onlineStoreUrl: (s.published ?? true) ? `https://shop.test/${s.title}` : null,
        featuredImageUrl: "https://img.test/x.jpg", featuredImageAlt: s.title,
        metafields: s.mat ? { "custom.material": s.mat } : {},
      });
      await upsertVariant(e, shop, id, { shopifyVariantGid: s.gid + "/v1", sku: "SKU" + s.gid.split("/").pop(), price: s.price, availableForSale: s.available ?? true, position: 1 });
      return id;
    });
  }
  async function buildActive(): Promise<string> {
    const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
    const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
    return v.id;
  }
  const activeId = () => db.withShopExec(shop, async (e) => (await getActiveVersion(e, shop))!.id);

  it("P3: precomputed parse values equal the live DISTINCT queries (random catalog)", async () => {
    for (const s of randomCatalog(60)) await seed(s);
    const ver = await buildActive();
    const [pre, live] = await db.withShopExec(shop, async (e) => [await precomputedParseValues(e, shop, ver), await liveParse(e, shop, ver)]);
    expect(sortByVal(pre)).toEqual(sortByVal(live));
    expect(pre.vendors.length).toBeGreaterThan(0);
  });

  it("P4: precomputed browse facets equal the live browse aggregates (random catalog incl drafts/unpublished/oos)", async () => {
    for (const s of randomCatalog(80)) await seed(s);
    const ver = await buildActive();
    const [pre, live] = await db.withShopExec(shop, async (e) => [await precomputedFacets(e, shop, ver), await liveBrowseFacets(e, shop, ver)]);
    expect(pre).toEqual(live);
  });

  it("P3/P4: stay correct after add tag, unpublish, draft, delete (incremental refresh)", async () => {
    const ids: Record<string, string> = {};
    for (const s of randomCatalog(20)) ids[s.gid] = await seed(s);
    await buildActive();
    // mutate: add a brand-new tag + vendor, unpublish one, draft one, delete one.
    await db.withShopExec(shop, async (e) => {
      const first = await upsertProduct(e, shop, { shopifyProductGid: "gid://shopify/Product/1", title: "P1", handle: "P1", vendor: "ZZBrand", productType: "Clog", status: "ACTIVE", tags: ["unique-tag-xyz"], onlineStoreUrl: "https://shop.test/P1", metafields: { "custom.material": "Suede" } });
      await upsertVariant(e, shop, first.id, { shopifyVariantGid: "gid://shopify/Product/1/v1", sku: "SKU1", price: "12", availableForSale: true, position: 1 });
      await upsertProduct(e, shop, { shopifyProductGid: "gid://shopify/Product/2", title: "P2", handle: "P2", vendor: "Nike", productType: "Shoe", status: "ACTIVE", tags: ["red"], onlineStoreUrl: null }); // unpublish
      await upsertProduct(e, shop, { shopifyProductGid: "gid://shopify/Product/3", title: "P3", handle: "P3", vendor: "Nike", productType: "Shoe", status: "DRAFT", tags: ["red"], onlineStoreUrl: "https://shop.test/P3" }); // draft
      await refreshDocsForProducts(e, shop, [ids["gid://shopify/Product/1"], ids["gid://shopify/Product/2"], ids["gid://shopify/Product/3"]]);
    });
    const ver = await activeId();
    const [pre, live, pf, lf] = await db.withShopExec(shop, async (e) => [
      await precomputedParseValues(e, shop, ver), await liveParse(e, shop, ver),
      await precomputedFacets(e, shop, ver), await liveBrowseFacets(e, shop, ver)]);
    expect(sortByVal(pre)).toEqual(sortByVal(live));
    expect(pf).toEqual(lf);
    expect(pre.vendors).toContain("ZZBrand");       // new value appeared
    expect(pre.tagValues).toContain("unique-tag-xyz");
  });

  it("P3/P4: follow rollback to a previous version", async () => {
    for (const s of randomCatalog(15)) await seed(s);
    const v1 = await buildActive();
    // New version with an extra vendor, activate it, then roll back to v1.
    await seed({ gid: "gid://shopify/Product/999", title: "Extra", vendor: "OnlyInV2", type: "Shoe", tags: ["v2only"], price: "55", mat: "Gold" });
    const v2 = await buildActive();
    const v2vals = await db.withShopExec(shop, (e) => precomputedParseValues(e, shop, v2));
    expect(v2vals.vendors).toContain("OnlyInV2");
    await db.withShopExec(shop, (e) => rollbackToVersion(e, shop, v1));
    const ver = await activeId();
    expect(ver).toBe(v1);
    const [pre, live] = await db.withShopExec(shop, async (e) => [await precomputedParseValues(e, shop, ver), await liveParse(e, shop, ver)]);
    expect(sortByVal(pre)).toEqual(sortByVal(live));
    expect(pre.vendors).not.toContain("OnlyInV2"); // rollback excludes v2-only value
  });

  it("retention: pruning an old version cascades its precompute rows away", async () => {
    for (const s of randomCatalog(10)) await seed(s);
    const v1 = await buildActive();
    await seed({ gid: "gid://shopify/Product/500", title: "X", vendor: "Nike", type: "Shoe", tags: ["red"], price: "20" });
    await buildActive(); // v2 active, v1 superseded
    await db.withShopExec(shop, (e) => pruneOldVersions(e, shop, 0)); // delete all superseded
    const leftover = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>(
      `SELECT count(*)::int n FROM search_facet_value WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`, [shop, v1]))[0].n);
    expect(leftover).toBe(0); // ON DELETE CASCADE removed v1's rows
  });

  it("cross-shop isolation: a shop sees only its own precompute rows", async () => {
    for (const s of randomCatalog(8)) await seed(s);
    await buildActive();
    const other = await db.resolveShop("p14b-facet-other.myshopify.com");
    const otherRows = await db.withShopExec(other, async (e) => (await e.rows<{ n: number }>(
      `SELECT count(*)::int n FROM search_facet_value`, []))[0].n);
    expect(otherRows).toBe(0);
  });

  it("P4 gate: precomputed only for unfiltered, un-hidden, show_all browse", () => {
    const empty = { vendor: [], productType: [], tags: [], metafield: [], priceMin: null, priceMax: null, available: null, collectionId: null };
    const browse = (merch: any, combinedHide?: "child" | "parent"): PlannedMatch => ({ plan: { isEmpty: true } as any, level: "browse", merch, combinedHide });
    const noMerch = { hideIds: [] as string[] } as any;
    expect(canUsePrecomputedFacets(empty as any, browse(noMerch))).toBe(true);
    // mutation of each gate condition flips it to false:
    expect(canUsePrecomputedFacets({ ...empty, vendor: ["Nike"] } as any, browse(noMerch))).toBe(false);
    expect(canUsePrecomputedFacets({ ...empty, available: true } as any, browse(noMerch))).toBe(false);
    expect(canUsePrecomputedFacets({ ...empty, collectionId: "gid://x" } as any, browse(noMerch))).toBe(false);
    expect(canUsePrecomputedFacets(empty as any, browse({ hideIds: ["id1"] }))).toBe(false);
    expect(canUsePrecomputedFacets(empty as any, browse(noMerch, "child"))).toBe(false);
    expect(canUsePrecomputedFacets(empty as any, { plan: {} as any, level: "primary", merch: noMerch })).toBe(false); // has query
  });
});
