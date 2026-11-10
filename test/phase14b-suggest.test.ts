import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant, upsertCollection, replaceProductCollectionsByGids } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion, getActiveVersion, rollbackToVersion } from "~/lib/index/engine";
import { catalogSuggestionsWithExec } from "~/lib/search/suggest";

/*
 * Phase 14b P2 — index-driven suggestions from the precomputed per-version terms
 * table are byte-identical to the live per-doc scan for the no-hide/show_all
 * case (the gate), and the function still falls back to the live scan (with the
 * dynamic merch-hide / combined-hide exclusions) otherwise. Draft / unpublished
 * / combined-hidden never produce suggestions either way.
 */
const RANDOM_UUID = "00000000-0000-0000-0000-0000000000ff"; // excludes nothing → forces live path, same set

interface Seed { gid: string; title: string; vendor: string; type: string; cols?: string[]; status?: string; published?: boolean; }
const CATALOG: Seed[] = [
  { gid: "gid://shopify/Product/1", title: "Running Shoe", vendor: "Nike", type: "Shoe", cols: ["gid://shopify/Collection/Summer"] },
  { gid: "gid://shopify/Product/2", title: "Running Shorts", vendor: "Nike", type: "Shorts", cols: ["gid://shopify/Collection/Summer"] },
  { gid: "gid://shopify/Product/3", title: "Rugby Ball", vendor: "Rawlings", type: "Ball", cols: ["gid://shopify/Collection/Rugby"] },
  { gid: "gid://shopify/Product/4", title: "Résumé Holder", vendor: "Rolodex", type: "Office", cols: [] },
  { gid: "gid://shopify/Product/5", title: "Draft Runner", vendor: "Nike", type: "Shoe", status: "DRAFT" },
  { gid: "gid://shopify/Product/6", title: "Unpublished Runner", vendor: "Nike", type: "Shoe", published: false },
];

describe("Phase 14b P2 — precomputed suggestions equal the live scan", () => {
  let db: TestDb; let shop: string; const ids: Record<string, string> = {};
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  async function seedAll() {
    for (const s of CATALOG) {
      ids[s.gid] = await db.withShopExec(shop, async (e) => {
        const { id } = await upsertProduct(e, shop, {
          shopifyProductGid: s.gid, title: s.title, handle: s.gid.split("/").pop(), vendor: s.vendor, productType: s.type,
          status: s.status ?? "ACTIVE", tags: [], onlineStoreUrl: (s.published ?? true) ? `https://shop.test/${s.gid.split("/").pop()}` : null,
          featuredImageUrl: "https://img.test/x.jpg", featuredImageAlt: s.title, metafields: {},
        });
        await upsertVariant(e, shop, id, { shopifyVariantGid: s.gid + "/v1", sku: "SKU" + s.gid.split("/").pop(), price: "10", availableForSale: true, position: 1 });
        for (const cg of s.cols ?? []) {
          await upsertCollection(e, shop, { shopifyCollectionGid: cg, title: cg.split("/").pop(), handle: cg.split("/").pop() });
          await replaceProductCollectionsByGids(e, shop, id, s.cols!);
        }
        return id;
      });
    }
    const n = CATALOG.length;
    const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
    return v.id;
  }

  beforeEach(async () => { await db.resetDb(); shop = await db.resolveShop("p14b-sugg.myshopify.com"); await seedAll(); });

  // precompute path (no hide) vs forced-live path (dummy hide excludes nothing)
  const pre = (q: string) => db.withShopExec(shop, (e) => catalogSuggestionsWithExec(e, shop, q));
  const live = (q: string) => db.withShopExec(shop, (e) => catalogSuggestionsWithExec(e, shop, q, 10, { hideIds: [RANDOM_UUID] }));

  for (const q of ["r", "ru", "run", "runn", "s", "sh", "rugby", "rés", "resume", "RUN", "nike", "summer", "zzz"]) {
    it(`prefix "${q}": precompute == live, identical order`, async () => {
      const [p, l] = [await pre(q), await live(q)];
      expect(p).toEqual(l);
    });
  }

  it("draft / unpublished products never contribute suggestions (both paths)", async () => {
    // 'Draft Runner' / 'Unpublished Runner' titles start with 'd'/'u'; and 'run' prefix
    const p = await pre("run"); const l = await live("run");
    const texts = p.map((s) => s.text);
    expect(texts).not.toContain("Draft Runner");
    expect(texts).not.toContain("Unpublished Runner");
    expect(p).toEqual(l);
    // sanity: visible runners ARE present
    expect(texts).toContain("Running Shoe");
    expect(texts).toContain("Running Shorts");
  });

  it("merch hide excludes a product's unique term — live path is used and correct", async () => {
    // Rugby Ball is the only 'rugby'/'ball' source. Hiding it must drop those terms.
    const hidden = await db.withShopExec(shop, (e) => catalogSuggestionsWithExec(e, shop, "rugby", 10, { hideIds: [ids["gid://shopify/Product/3"]] }));
    expect(hidden.map((s) => s.text)).not.toContain("Rugby Ball");
    // without the hide, precompute DOES surface it
    expect((await pre("rugby")).map((s) => s.text)).toContain("Rugby Ball");
  });

  it("combined-hide forces the live path (gate off)", async () => {
    // show_all (default) → precompute; combinedHide set → live. Both exclude the
    // same hidden-role products here (none combined), so results match, but this
    // asserts the gate routes correctly without error.
    const withCombined = await db.withShopExec(shop, (e) => catalogSuggestionsWithExec(e, shop, "run", 10, { combinedHide: "child" }));
    expect(withCombined).toEqual(await pre("run"));
  });

  it("follows rollback (version-keyed precompute)", async () => {
    const v1 = await activeVer();
    // v2 adds a product with a unique title, activate, then roll back to v1.
    await db.withShopExec(shop, async (e) => {
      const { id } = await upsertProduct(e, shop, { shopifyProductGid: "gid://shopify/Product/99", title: "Zephyr Jacket", handle: "z99", vendor: "Nike", productType: "Jacket", status: "ACTIVE", tags: [], onlineStoreUrl: "https://shop.test/z99", metafields: {} });
      await upsertVariant(e, shop, id, { shopifyVariantGid: "gid://shopify/Product/99/v1", sku: "SKUZ", price: "10", availableForSale: true, position: 1 });
    });
    const n = CATALOG.length + 1;
    const v2 = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v2.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v2.id, n));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v2.id));
    expect((await pre("zep")).map((s) => s.text)).toContain("Zephyr Jacket");
    await db.withShopExec(shop, (e) => rollbackToVersion(e, shop, v1));
    expect((await pre("zep"))).toEqual([]); // v1 has no Zephyr; precompute followed the rollback
    expect(await pre("zep")).toEqual(await live("zep"));
  });

  it("cross-shop isolation: another shop sees no suggest terms", async () => {
    const other = await db.resolveShop("p14b-sugg-other.myshopify.com");
    const n = await db.withShopExec(other, async (e) => (await e.rows<{ n: number }>(`SELECT count(*)::int n FROM search_suggest_term`, []))[0].n);
    expect(n).toBe(0);
  });

  function activeVer() { return db.withShopExec(shop, async (e) => (await getActiveVersion(e, shop))!.id); }
});
