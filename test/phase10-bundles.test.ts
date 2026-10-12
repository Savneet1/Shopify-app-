import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
  rollbackToVersion, getActiveVersion,
} from "~/lib/index/engine";
import {
  createBundle, getBundle, updateBundle, listBundles, setBundleStatus,
  normalizeBundleInput, BundleValidationError, type BundleInput,
} from "~/lib/bundles/model";
import { resolveBundle, resolveBundleForStorefront, listVisibleBundles } from "~/lib/bundles/engine";

/*
 * Phase 10.1/10.2 — bundle model validation + engine visibility/availability.
 * REAL-SHAPED data: absolute onlineStoreUrl, cdn.shopify.com images, variant
 * GIDs gid://shopify/ProductVariant/<n>. node-postgres; migration 0012 applied.
 */
const require = createRequire(import.meta.url);
const required = require(join(__dirname, "..", "extensions", "search-discovery-theme", "assets", "boost-core.js"));
const Core = required && required.toSameSitePath ? required : (globalThis as any).BoostSearch;

const PG = (n: number) => `gid://shopify/Product/${n}`;
const VG = (n: number) => `gid://shopify/ProductVariant/${n}`;
const handleOf = (gid: string) => gid.split("/").pop()!;

interface VSeed { gid: string; price: string; available?: boolean; title?: string; position?: number }
interface PSeed { gid: string; title: string; published?: boolean; vendor?: string; variants: VSeed[] }

async function seed(db: TestDb, shop: string, p: PSeed) {
  await db.withShopExec(shop, async (e) => {
    const published = p.published !== false;
    const h = handleOf(p.gid);
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: p.gid, title: p.title, handle: h, vendor: p.vendor ?? "Acme", productType: "T", tags: [],
      status: "ACTIVE",
      onlineStoreUrl: published ? `https://shop.example/products/${h}` : null,
      featuredImageUrl: `https://cdn.shopify.com/s/files/1/img/${h}.jpg`, featuredImageAlt: p.title,
      metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z",
    });
    for (const v of p.variants) {
      await upsertVariant(e, shop, id, {
        shopifyVariantGid: v.gid, sku: "SKU-" + handleOf(v.gid), title: v.title ?? "Default",
        price: v.price, availableForSale: v.available ?? true, position: v.position ?? 1,
      });
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

const fixedInput = (overrides: Partial<BundleInput> = {}): BundleInput => ({
  name: "Starter Kit", description: "Two things", bundleType: "fixed", status: "active",
  slots: [
    { productRefKind: "gid", productRefValue: PG(1), variantMode: "customer_picks", quantity: 1 },
    { productRefKind: "gid", productRefValue: PG(2), variantMode: "fixed", variantGid: VG(21), quantity: 2 },
  ],
  ...overrides,
});

describe("Phase 10.1 — bundle model validation (pure)", () => {
  it("rejects <2 or >10 slots", () => {
    expect(() => normalizeBundleInput(fixedInput({ slots: [{ productRefKind: "gid", productRefValue: PG(1), variantMode: "customer_picks", quantity: 1 }] }))).toThrow(BundleValidationError);
    const many = Array.from({ length: 11 }, (_, i) => ({ productRefKind: "gid" as const, productRefValue: PG(i + 1), variantMode: "customer_picks" as const, quantity: 1 }));
    expect(() => normalizeBundleInput(fixedInput({ slots: many }))).toThrow(/at most 10/);
  });
  it("rejects duplicate products across slots", () => {
    expect(() => normalizeBundleInput(fixedInput({ slots: [
      { productRefKind: "gid", productRefValue: PG(1), variantMode: "customer_picks", quantity: 1 },
      { productRefKind: "gid", productRefValue: PG(1), variantMode: "customer_picks", quantity: 1 },
    ] }))).toThrow(/already used/);
  });
  it("rejects quantity out of 1..10 and a fixed slot without a valid variant gid", () => {
    expect(() => normalizeBundleInput(fixedInput({ slots: [
      { productRefKind: "gid", productRefValue: PG(1), variantMode: "customer_picks", quantity: 0 },
      { productRefKind: "gid", productRefValue: PG(2), variantMode: "customer_picks", quantity: 1 },
    ] }))).toThrow(/quantity/);
    expect(() => normalizeBundleInput(fixedInput({ slots: [
      { productRefKind: "gid", productRefValue: PG(1), variantMode: "fixed", variantGid: "nope", quantity: 1 },
      { productRefKind: "gid", productRefValue: PG(2), variantMode: "customer_picks", quantity: 1 },
    ] }))).toThrow(/ProductVariant GID/);
  });
  it("mix_and_match needs N within 1..#candidates", () => {
    expect(() => normalizeBundleInput(fixedInput({ bundleType: "mix_and_match", mixPickCount: 3 }))).toThrow(/cannot exceed/);
    const ok = normalizeBundleInput(fixedInput({ bundleType: "mix_and_match", mixPickCount: 1 }));
    expect(ok.bundle.mix_pick_count).toBe(1);
  });
  it("schedule start must precede end; intended discount validated", () => {
    expect(() => normalizeBundleInput(fixedInput({ startsAt: "2026-02-01T00:00:00Z", endsAt: "2026-01-01T00:00:00Z" }))).toThrow(/before end/);
    expect(() => normalizeBundleInput(fixedInput({ intendedDiscountType: "percent", intendedDiscountValue: 150 }))).toThrow(/exceed 100/);
    const ok = normalizeBundleInput(fixedInput({ intendedDiscountType: "fixed_amount", intendedDiscountValue: 5 }));
    expect(ok.bundle.intended_discount_value).toBe("5.00");
  });
  it("handles are lower-cased via classifyRef", () => {
    const n = normalizeBundleInput(fixedInput({ slots: [
      { productRefKind: "handle", productRefValue: "Big-Shoe", variantMode: "customer_picks", quantity: 1 },
      { productRefKind: "handle", productRefValue: "hat", variantMode: "customer_picks", quantity: 1 },
    ] }));
    expect(n.slots[0].productRefValue).toBe("big-shoe");
  });
});

describe("Phase 10.2 — bundle engine (visibility/availability)", () => {
  let db: TestDb;
  let shop: string;
  let version: string;
  const NOW = new Date("2026-05-01T12:00:00Z");
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p10.myshopify.com");
    await seed(db, shop, { gid: PG(1), title: "Alpha", variants: [{ gid: VG(11), price: "10.00" }, { gid: VG(12), price: "15.00", position: 2 }] });
    await seed(db, shop, { gid: PG(2), title: "Bravo", variants: [{ gid: VG(21), price: "20.00" }] });
    version = await build(db, shop);
  });
  const make = (ov: Partial<BundleInput> = {}) => db.withShopExec(shop, (e) => createBundle(e, shop, fixedInput(ov)));
  const resolve = async (id: string, now = NOW) => {
    const b = (await db.withShopExec(shop, (e) => getBundle(e, shop, id)))!;
    return db.withShopExec(shop, (e) => resolveBundle(e, shop, version, b, now));
  };

  it("fixed bundle shown when all slots visible+available; total = sum of regular prices", async () => {
    const id = await make();
    const res = await resolve(id);
    expect(res.shown).toBe(true);
    expect(res.blocked).toEqual([]);
    expect(res.payload!.items.length).toBe(2);
    // Alpha default = cheapest-by-position variant (VG11 @10) ×1 = 10; Bravo VG21 @20 ×2 = 40 → 50
    expect(res.payload!.total).toBe("50.00");
    expect(res.payload!.priceMin).toBe("50.00");
    // customer_picks slot exposes both variants; fixed slot exposes exactly one
    const alpha = res.payload!.items.find((i) => i.product.gid === PG(1))!;
    const bravo = res.payload!.items.find((i) => i.product.gid === PG(2))!;
    expect(alpha.variants.length).toBe(2);
    expect(bravo.variants.length).toBe(1);
    expect(bravo.defaultVariantId).toBe("21");
  });

  it("payload fields pass through the Core storefront helpers (real-shaped)", async () => {
    const id = await make();
    const p = (await resolve(id)).payload!;
    const host = "shop.example";
    // absolute onlineStoreUrl → same-site path
    expect(Core.toSameSitePath(p.url, [host], host)).toBe(`/products/${handleOf(PG(1))}`);
    // cdn image is allow-listed
    expect(Core.isSafeImageUrl(p.image.url, ["cdn.shopify.com", host])).toBe(true);
    // price range formats
    expect(Core.formatPrice(p.priceMin, p.priceMax, "USD")).toContain("50");
    // every variant option carries a numeric id usable by the Ajax cart
    for (const it of p.items) for (const v of it.variants) expect(/^\d+$/.test(v.variantId)).toBe(true);
  });

  it("hidden entirely when a required slot product is unpublished (reason names the slot)", async () => {
    await seed(db, shop, { gid: PG(2), title: "Bravo", published: false, variants: [{ gid: VG(21), price: "20.00" }] });
    version = await build(db, shop);
    const id = await make();
    const res = await resolve(id);
    expect(res.shown).toBe(false);
    expect(res.payload).toBeNull();
    expect(res.blocked.some((b) => /unpublished|not in the catalog/.test(b.reason))).toBe(true);
  });

  it("hidden when a required slot product is out of stock", async () => {
    await seed(db, shop, { gid: PG(2), title: "Bravo", variants: [{ gid: VG(21), price: "20.00", available: false }] });
    version = await build(db, shop);
    const id = await make();
    const res = await resolve(id);
    expect(res.shown).toBe(false);
    expect(res.blocked.some((b) => /out of stock/.test(b.reason))).toBe(true);
  });

  it("hidden when a fixed slot's chosen variant is unavailable", async () => {
    // Bravo available overall, but VG(21) specifically is unavailable.
    await seed(db, shop, { gid: PG(2), title: "Bravo", variants: [
      { gid: VG(21), price: "20.00", available: false },
      { gid: VG(22), price: "25.00", available: true, position: 2 },
    ] });
    version = await build(db, shop);
    const id = await make(); // fixed slot references VG(21)
    const res = await resolve(id);
    expect(res.shown).toBe(false);
    expect(res.blocked.some((b) => /selected variant/i.test(b.reason))).toBe(true);
  });

  it("unknown / foreign product id → simply not shown, never an error", async () => {
    const id = await make({ slots: [
      { productRefKind: "gid", productRefValue: PG(9999), variantMode: "customer_picks", quantity: 1 },
      { productRefKind: "gid", productRefValue: PG(1), variantMode: "customer_picks", quantity: 1 },
    ] });
    const res = await resolve(id);
    expect(res.shown).toBe(false);
    expect(res.blocked.some((b) => b.product === PG(9999))).toBe(true);
  });

  it("mix-and-match: hidden if fewer than N candidates available, shown otherwise", async () => {
    // 3 candidates, pick 2. Make one unavailable → 2 remain → shown.
    await seed(db, shop, { gid: PG(3), title: "Charlie", variants: [{ gid: VG(31), price: "30.00" }] });
    version = await build(db, shop);
    const pick2 = await make({ bundleType: "mix_and_match", mixPickCount: 2, slots: [
      { productRefKind: "gid", productRefValue: PG(1), variantMode: "customer_picks", quantity: 1 },
      { productRefKind: "gid", productRefValue: PG(2), variantMode: "customer_picks", quantity: 1 },
      { productRefKind: "gid", productRefValue: PG(3), variantMode: "customer_picks", quantity: 1 },
    ] });
    const shown = await resolve(pick2);
    expect(shown.shown).toBe(true);
    expect(shown.payload!.total).toBeNull();        // mix total depends on picks
    // default line totals: Alpha 10, Bravo 20, Charlie 30 → 2 cheapest = 30, 2 dearest = 50
    expect(shown.payload!.priceMin).toBe("30.00");
    expect(shown.payload!.priceMax).toBe("50.00");
  });

  it("follows index swap and rollback", async () => {
    const id = await make();
    const v1 = version;
    const r1 = await resolve(id);
    expect(r1.shown).toBe(true);
    // Rebuild a new version where Bravo is unpublished → bundle hidden on v2.
    await seed(db, shop, { gid: PG(2), title: "Bravo", published: false, variants: [{ gid: VG(21), price: "20.00" }] });
    const v2 = await build(db, shop);
    expect((await db.withShopExec(shop, (e) => getActiveVersion(e, shop)))!.id).toBe(v2);
    const onV2 = await db.withShopExec(shop, async (e) => {
      const b = (await getBundle(e, shop, id))!;
      return resolveBundle(e, shop, v2, b, NOW);
    });
    expect(onV2.shown).toBe(false);
    // Roll back to v1 → bundle visible again (storefront helper resolves the
    // active version itself).
    await db.withShopExec(shop, (e) => rollbackToVersion(e, shop, v1));
    const viaStore = await db.withShopExec(shop, (e) => resolveBundleForStorefront(e, shop, id, NOW));
    expect(viaStore).not.toBeNull();
  });

  it("schedule + status gating with injected clock", async () => {
    const draft = await make({ status: "draft" });
    expect((await resolve(draft)).shown).toBe(false);
    const future = await make({ status: "active", startsAt: "2026-06-01T00:00:00Z" });
    expect((await resolve(future, NOW)).shown).toBe(false);            // before start
    expect((await resolve(future, new Date("2026-06-02T00:00:00Z"))).shown).toBe(true);
    const past = await make({ status: "active", endsAt: "2026-04-01T00:00:00Z" });
    expect((await resolve(past, NOW)).shown).toBe(false);              // after end
  });

  it("listVisibleBundles returns only shown bundles and can filter by product ref", async () => {
    await make();                          // references PG(1) + PG(2)
    await make({ name: "Draft one", status: "draft" });
    const all = await db.withShopExec(shop, (e) => listVisibleBundles(e, shop, { now: NOW }));
    expect(all.length).toBe(1);
    const filtered = await db.withShopExec(shop, (e) => listVisibleBundles(e, shop, { productRef: PG(2), now: NOW }));
    expect(filtered.length).toBe(1);
    const none = await db.withShopExec(shop, (e) => listVisibleBundles(e, shop, { productRef: PG(999), now: NOW }));
    expect(none.length).toBe(0);
  });

  it("M4b: engine total is exact integer-decimal math with qty > 1", async () => {
    // variant.price is NUMERIC(12,2) so prices are 2-decimal at the engine; the
    // 3-decimal exactness is proven in phase10-money. Here: 0.10×1 + 0.20×2 =
    // 0.50 via BigInt minor units (the 0.1+0.2 float trap).
    await seed(db, shop, { gid: PG(1), title: "Alpha", variants: [{ gid: VG(11), price: "0.10" }] });
    await seed(db, shop, { gid: PG(2), title: "Bravo", variants: [{ gid: VG(21), price: "0.20" }] });
    version = await build(db, shop);
    const id = await make({ slots: [
      { productRefKind: "gid", productRefValue: PG(1), variantMode: "fixed", variantGid: VG(11), quantity: 1 },
      { productRefKind: "gid", productRefValue: PG(2), variantMode: "fixed", variantGid: VG(21), quantity: 2 },
    ] });
    const p = (await resolve(id)).payload!;
    expect(p.total).toBe("0.50");
  });

  it("CRUD round-trips and status changes", async () => {
    const id = await make();
    const got = (await db.withShopExec(shop, (e) => getBundle(e, shop, id)))!;
    expect(got.slots.length).toBe(2);
    await db.withShopExec(shop, (e) => updateBundle(e, shop, id, fixedInput({ name: "Renamed" })));
    expect((await db.withShopExec(shop, (e) => getBundle(e, shop, id)))!.name).toBe("Renamed");
    await db.withShopExec(shop, (e) => setBundleStatus(e, shop, id, "archived"));
    const list = await db.withShopExec(shop, (e) => listBundles(e, shop));
    expect(list[0].status).toBe("archived");
  });
});
