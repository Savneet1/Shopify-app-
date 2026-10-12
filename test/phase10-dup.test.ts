import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { createBundle, getBundle, BundleValidationError, type BundleInput, type SlotInput, type BundleWithSlots } from "~/lib/bundles/model";
import { buildSlotMaps, resolveBundleWithMaps } from "~/lib/bundles/engine";

/*
 * Phase 10.1 M2 — duplicate detection by RESOLVED product identity, at the save
 * path and at resolve time.
 */
const PG = (n: number) => `gid://shopify/Product/${n}`;
const VG = (n: number) => `gid://shopify/ProductVariant/${n}`;

async function seed(db: TestDb, shop: string, gid: string, handle: string, vgid: string) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: gid, title: handle, handle, vendor: "V", productType: "T", tags: [], status: "ACTIVE",
      onlineStoreUrl: `https://shop.example/products/${handle}`, featuredImageUrl: `https://cdn.shopify.com/${handle}.jpg`,
      metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: vgid, sku: "S-" + handle, price: "10.00", availableForSale: true });
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
const slot = (kind: "gid" | "handle", value: string): SlotInput => ({ productRefKind: kind, productRefValue: value, variantMode: "customer_picks", quantity: 1 });

describe("Phase 10.1 M2 — duplicate by resolved identity", () => {
  let db: TestDb;
  let shop: string;
  let version: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p10d.myshopify.com");
    await seed(db, shop, PG(1), "red-shoe", VG(11));
    await seed(db, shop, PG(2), "blue-hat", VG(21));
    version = await build(db, shop);
  });

  it("save path rejects one product entered once by gid and once by handle", async () => {
    const input: BundleInput = { name: "Dup", bundleType: "fixed", status: "active", slots: [slot("gid", PG(1)), slot("handle", "red-shoe")] };
    await expect(db.withShopExec(shop, (e) => createBundle(e, shop, input))).rejects.toThrow(BundleValidationError);
    await expect(db.withShopExec(shop, (e) => createBundle(e, shop, input))).rejects.toThrow(/same product/i);
  });

  it("save path allows distinct products and unresolvable refs", async () => {
    // distinct products OK
    const ok = await db.withShopExec(shop, (e) => createBundle(e, shop, { name: "OK", bundleType: "fixed", status: "active", slots: [slot("gid", PG(1)), slot("gid", PG(2))] }));
    expect(ok).toBeTruthy();
    // an unresolvable ref alongside a real one is allowed (draft may reference not-yet-visible products)
    const draft = await db.withShopExec(shop, (e) => createBundle(e, shop, { name: "Draft", bundleType: "fixed", status: "draft", slots: [slot("gid", PG(1)), slot("handle", "not-yet-live")] }));
    expect(draft).toBeTruthy();
  });

  it("existing identical-normalised-ref rejection is unchanged (pure)", async () => {
    await expect(db.withShopExec(shop, (e) => createBundle(e, shop, { name: "X", bundleType: "fixed", status: "active", slots: [slot("gid", PG(1)), slot("gid", PG(1))] }))).rejects.toThrow(/already used/);
  });

  it("resolve time blocks a bundle whose two slots resolve to the same product", async () => {
    // Build a bundle object directly (bypassing the save guard) with a gid slot
    // and a handle slot that both resolve to red-shoe once it is visible.
    const bundle: BundleWithSlots = {
      id: "00000000-0000-0000-0000-0000000000aa", name: "RT", description: "",
      bundle_type: "fixed", status: "active", mix_pick_count: null, placement: "product",
      position: 100, starts_at: null, ends_at: null, timezone: null,
      intended_discount_type: null, intended_discount_value: null, intended_discount_note: "",
      created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
      slots: [
        { id: "s1", position: 1, product_ref_kind: "gid", product_ref_value: PG(1), variant_mode: "customer_picks", variant_gid: null, quantity: 1 },
        { id: "s2", position: 2, product_ref_kind: "handle", product_ref_value: "red-shoe", variant_mode: "customer_picks", variant_gid: null, quantity: 1 },
      ],
    };
    const maps = await db.withShopExec(shop, (e) => buildSlotMaps(e, shop, version, bundle.slots));
    const res = resolveBundleWithMaps(bundle, maps, new Date("2026-05-01T00:00:00Z"));
    expect(res.shown).toBe(false);
    expect(res.blocked.some((b) => /duplicate lines/i.test(b.reason))).toBe(true);
  });
});
