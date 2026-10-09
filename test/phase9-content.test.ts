import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant, upsertCollection, replaceProductCollectionsByGids } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
  rollbackToVersion, getActiveVersion,
} from "~/lib/index/engine";
import { recommendContent, resolveRefsToProductIds } from "~/lib/recommend/content";
import { parseRecentRefs, classifyRef } from "~/lib/recommend/refs";

/*
 * Phase 9.1 engine tests — content-based recommendations over the ACTIVE index
 * version's VISIBLE docs. node-postgres (same SQL as production Prisma).
 * Migration 0011 must be applied to the test DB (scripts/db-apply.sh).
 */

interface Seed {
  gid: string; title: string; vendor: string; type: string; tags: string[];
  price: string; available?: boolean; status?: string; published?: boolean;
  collections?: { gid: string; title: string }[];
}
const G = (n: number) => `gid://shopify/Product/${n}`;
const handleOf = (gid: string) => gid.split("/").pop()!;

async function seed(db: TestDb, shop: string, s: Seed) {
  await db.withShopExec(shop, async (e) => {
    const published = s.published !== false;
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: s.gid, title: s.title, handle: handleOf(s.gid), vendor: s.vendor,
      productType: s.type, tags: s.tags, status: s.status ?? "ACTIVE",
      onlineStoreUrl: published ? `https://shop.example/products/${handleOf(s.gid)}` : null,
      featuredImageUrl: `https://cdn.shopify.com/img/${handleOf(s.gid)}.jpg`,
      metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, {
      shopifyVariantGid: s.gid + "/v", sku: "SKU-" + handleOf(s.gid), price: s.price,
      availableForSale: s.available ?? true,
    });
    for (const c of s.collections ?? []) {
      await upsertCollection(e, shop, { shopifyCollectionGid: c.gid, title: c.title, handle: handleOf(c.gid) });
    }
    if (s.collections && s.collections.length) {
      await replaceProductCollectionsByGids(e, shop, id, s.collections.map((c) => c.gid));
    }
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

const COL_FOOT = { gid: "gid://shopify/Collection/1", title: "Footwear" };
const COL_SALE = { gid: "gid://shopify/Collection/2", title: "Sale" };
const COL_OTHER = { gid: "gid://shopify/Collection/3", title: "Other" };

// Titles are deliberately dissimilar so trigram similarity ≈ 0 and attribute
// overlap drives the score, making the expected order exact.
const SEED: Seed = { gid: G(1), title: "Zeta", vendor: "Nike", type: "Shoe", tags: ["running", "blue"], price: "100.00", collections: [COL_FOOT, COL_SALE] };
const CAT: Seed[] = [
  SEED,
  // full overlap (2 cols + type + vendor + 2 tags + exact price) → top
  { gid: G(2), title: "Qux1", vendor: "Nike", type: "Shoe", tags: ["running", "blue"], price: "100.00", collections: [COL_FOOT, COL_SALE] },
  // 2 shared collections only
  { gid: G(3), title: "Qux2", vendor: "Acme", type: "Hat", tags: ["x"], price: "1000.00", collections: [COL_FOOT, COL_SALE] },
  // same type only
  { gid: G(4), title: "Qux3", vendor: "Beta", type: "Shoe", tags: ["y"], price: "1000.00", collections: [] },
  // no overlap at all → score 0 → never returned
  { gid: G(5), title: "Qux4", vendor: "Gamma", type: "Bag", tags: ["z"], price: "1.00", collections: [COL_OTHER] },
];

describe("Phase 9.1 — content recommendations engine", () => {
  let db: TestDb;
  let shop: string;
  let versionId: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p9.myshopify.com");
    for (const s of CAT) await seed(db, shop, s);
    versionId = await build(db, shop);
  });

  const rec = (seedRef: string, opts: Partial<Parameters<typeof recommendContent>[4]> = {}) =>
    db.withShopExec(shop, (e) => recommendContent(e, shop, versionId, [classifyRef(seedRef)!], {
      kind: "similar", limit: 24, includeOutOfStock: false, diversifyPerVendor: 0, hideIds: [], ...opts,
    }));

  it("ranks by weighted overlap with deterministic order; excludes no-overlap and seed", async () => {
    const out = await rec(G(1));
    expect(out.map((p) => p.title)).toEqual(["Qux1", "Qux2", "Qux3"]);
    // seed never recommends itself
    expect(out.find((p) => p.gid === G(1))).toBeUndefined();
    // Qux4 (no overlap) absent
    expect(out.find((p) => p.title === "Qux4")).toBeUndefined();
    // monotonic score
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(out[1].score).toBeGreaterThan(out[2].score);
  });

  it("is deterministic across repeated calls", async () => {
    const a = await rec(G(1));
    const b = await rec(G(1));
    expect(a.map((p) => [p.id, p.score])).toEqual(b.map((p) => [p.id, p.score]));
  });

  it("resolves the seed by handle and by uuid identically to gid", async () => {
    const byGid = await rec(G(1));
    const byHandle = await rec(handleOf(G(1)));
    expect(byHandle.map((p) => p.id)).toEqual(byGid.map((p) => p.id));
    const none = await resolveRefsToProductIds(db.rootExec, shop, versionId, []);
    expect(none).toEqual([]); // empty refs → empty (no DB touch)
  });

  it("explain=true returns a component breakdown that sums to the score", async () => {
    const out = await rec(G(1), { explain: true });
    const top = out[0];
    expect(top.breakdown).toBeTruthy();
    const b = top.breakdown!;
    const sum = b.collections + b.productType + b.vendor + b.tags + b.price + b.title;
    expect(Math.abs(sum - top.score)).toBeLessThan(1e-6);
    // full-overlap item: all attribute components positive
    expect(b.collections).toBeGreaterThan(0);
    expect(b.productType).toBeGreaterThan(0);
    expect(b.vendor).toBeGreaterThan(0);
    expect(b.tags).toBeGreaterThan(0);
  });

  it("unknown / invalid / unpublished seed → empty list (never throws)", async () => {
    expect(await rec(G(9999))).toEqual([]);                 // unknown
    expect(await rec("not-a-real-handle-xyz")).toEqual([]); // unknown handle
    // unpublished seed is not a visible doc → treated as unknown
    await seed(db, shop, { gid: G(50), title: "Hidden", vendor: "Nike", type: "Shoe", tags: ["running"], price: "100", published: false, collections: [COL_FOOT] });
    versionId = await build(db, shop);
    expect(await rec(G(50))).toEqual([]);
  });

  it("out-of-stock excluded by default, included when includeOutOfStock", async () => {
    await seed(db, shop, { gid: G(6), title: "Qux5", vendor: "Nike", type: "Shoe", tags: ["running", "blue"], price: "100", available: false, collections: [COL_FOOT, COL_SALE] });
    versionId = await build(db, shop);
    const excluded = await rec(G(1));
    expect(excluded.find((p) => p.gid === G(6))).toBeUndefined();
    const included = await rec(G(1), { includeOutOfStock: true });
    expect(included.find((p) => p.gid === G(6))).toBeTruthy();
  });

  it("respects Phase 8 hide (a hidden product is never recommended)", async () => {
    const full = await rec(G(1));
    const hideId = full[0].id; // hide the top candidate
    const hidden = await rec(G(1), { hideIds: [hideId] });
    expect(hidden.find((p) => p.id === hideId)).toBeUndefined();
    expect(hidden.map((p) => p.title)).toEqual(["Qux2", "Qux3"]);
  });

  it("excludeProductIds drops already-seen products (recently-viewed)", async () => {
    const full = await rec(G(1));
    const drop = full[1].id;
    const out = await rec(G(1), { excludeProductIds: [drop] });
    expect(out.find((p) => p.id === drop)).toBeUndefined();
  });

  it("caps the result count", async () => {
    const out = await rec(G(1), { limit: 1 });
    expect(out.length).toBe(1);
    expect(out[0].title).toBe("Qux1");
  });

  it("per-vendor diversification cap limits one vendor's contribution", async () => {
    // Add a second Nike full-overlap item (slightly lower price distance keeps
    // it just under Qux1). With cap=1, only the stronger Nike item survives.
    await seed(db, shop, { gid: G(7), title: "Qux6", vendor: "Nike", type: "Shoe", tags: ["running", "blue"], price: "150", collections: [COL_FOOT, COL_SALE] });
    versionId = await build(db, shop);
    const capped = await db.withShopExec(shop, (e) => recommendContent(e, shop, versionId, [classifyRef(G(1))!], {
      kind: "similar", limit: 24, includeOutOfStock: false, diversifyPerVendor: 1, hideIds: [],
    }));
    const nike = capped.filter((p) => p.vendor === "Nike");
    expect(nike.length).toBe(1);
    expect(nike[0].title).toBe("Qux1"); // the stronger Nike item
  });

  it("'related' profile weights shared collections/tags over title/price", async () => {
    const out = await db.withShopExec(shop, (e) => recommendContent(e, shop, versionId, [classifyRef(G(1))!], {
      kind: "related", limit: 24, includeOutOfStock: false, diversifyPerVendor: 0, hideIds: [], explain: true,
    }));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].title).toBe("Qux1");
  });

  it("K3: tag overlap is case-insensitive (Sport == sport) and matches same-case", async () => {
    // Fresh products with a vendor/type not shared by CAT, so only these match.
    await seed(db, shop, { gid: G(20), title: "Kseed", vendor: "ZV", type: "ZT", tags: ["Sport", "Red"], price: "100" });
    await seed(db, shop, { gid: G(21), title: "Kmixed", vendor: "ZV", type: "ZT", tags: ["sport"], price: "100" }); // lower-case
    await seed(db, shop, { gid: G(22), title: "Ksame", vendor: "ZV", type: "ZT", tags: ["Sport"], price: "100" });  // same-case
    versionId = await build(db, shop);
    const out = await rec(G(20), { explain: true });
    const mixed = out.find((p) => p.gid === G(21));
    const same = out.find((p) => p.gid === G(22));
    expect(mixed).toBeTruthy();
    expect(same).toBeTruthy();
    // "sport" matches seed "Sport": tag component is positive and identical.
    expect(mixed!.breakdown!.tags).toBeGreaterThan(0);
    expect(mixed!.breakdown!.tags).toBe(same!.breakdown!.tags);
  });

  it("follows an index swap and a rollback automatically", async () => {
    const v1 = versionId;
    // rebuild a new active version with an extra candidate
    await seed(db, shop, { gid: G(8), title: "Qux7", vendor: "Nike", type: "Shoe", tags: ["running", "blue"], price: "100", collections: [COL_FOOT, COL_SALE] });
    const v2 = await build(db, shop);
    const active = await db.withShopExec(shop, (e) => getActiveVersion(e, shop));
    expect(active!.id).toBe(v2);
    const onV2 = await db.withShopExec(shop, (e) => recommendContent(e, shop, v2, [classifyRef(G(1))!], {
      kind: "similar", limit: 24, includeOutOfStock: false, diversifyPerVendor: 0, hideIds: [],
    }));
    expect(onV2.find((p) => p.gid === G(8))).toBeTruthy();
    // rollback to v1 → new product gone from the active version
    await db.withShopExec(shop, (e) => rollbackToVersion(e, shop, v1));
    const back = await db.withShopExec(shop, (e) => getActiveVersion(e, shop));
    expect(back!.id).toBe(v1);
    const onV1 = await db.withShopExec(shop, (e) => recommendContent(e, shop, v1, [classifyRef(G(1))!], {
      kind: "similar", limit: 24, includeOutOfStock: false, diversifyPerVendor: 0, hideIds: [],
    }));
    expect(onV1.find((p) => p.gid === G(8))).toBeUndefined();
  });
});

describe("Phase 9.1 — refs (pure)", () => {
  it("classifies uuid / gid / handle and rejects junk", () => {
    expect(classifyRef("550e8400-e29b-41d4-a716-446655440000")?.kind).toBe("uuid");
    expect(classifyRef("gid://shopify/Product/123")?.kind).toBe("gid");
    expect(classifyRef("blue-running-shoe")?.kind).toBe("handle");
    expect(classifyRef("UPPER-Handle")?.value).toBe("upper-handle"); // lower-cased
    expect(classifyRef("gid://shopify/Variant/1")).toBeNull();       // wrong gid type
    expect(classifyRef("javascript:alert(1)")).toBeNull();
    expect(classifyRef("a b c")).toBeNull();                         // spaces
    expect(classifyRef("")).toBeNull();
    expect(classifyRef("x".repeat(256))).toBeNull();
  });
  it("parseRecentRefs validates, dedups, caps at 12, preserves order", () => {
    const refs = parseRecentRefs("a,b,a,c, bad handle ,gid://shopify/Product/9,d,e,f,g,h,i,j,k,l,m");
    expect(refs.length).toBeLessThanOrEqual(12);
    const vals = refs.map((r) => r.value);
    expect(vals.slice(0, 4)).toEqual(["a", "b", "c", "gid://shopify/Product/9"]);
    // dedup: only one "a"
    expect(vals.filter((v) => v === "a").length).toBe(1);
  });
});
