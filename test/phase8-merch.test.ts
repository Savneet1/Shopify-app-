import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
} from "~/lib/index/engine";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { predictiveWithExec } from "~/lib/search/predictive";
import { createRule, loadMerchPlan, listRules } from "~/lib/merch/rules";
import { createExperiment, setExperimentStatus, recordEvent, exposureReport } from "~/lib/merch/experiments";
import { createBanner } from "~/lib/merch/banners";
import { assignVariant } from "~/lib/merch/assign";

/*
 * Phase 8 engine tests — merchandising applied INSIDE the one planner.
 * node-postgres (same SQL as production Prisma). Migration 0010 must be applied
 * to the test DB (scripts/db-apply.sh).
 */

interface Seed {
  gid: string; title: string; vendor: string; type: string; tags: string[];
  price: string; available?: boolean; status?: string; sku?: string;
}
async function seed(db: TestDb, shop: string, s: Seed) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: s.gid, title: s.title, handle: s.gid.split("/").pop(), vendor: s.vendor,
      productType: s.type, tags: s.tags, status: s.status ?? "ACTIVE",
      onlineStoreUrl: `https://shop.example/products/${s.gid.split("/").pop()}`,
      metafields: {}, productCreatedAt: "2024-01-01T00:00:00Z",
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: s.gid + "/v", sku: s.sku ?? ("SKU-" + s.gid.split("/").pop()), price: s.price, availableForSale: s.available ?? true });
  });
}
async function build(db: TestDb, shop: string) {
  const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  return v.id;
}
const G = (n: number) => `gid://shopify/Product/${n}`;

const CAT: Seed[] = [
  { gid: G(1), title: "Alpha Shoe", vendor: "Nike", type: "Shoe", tags: ["red"], price: "50.00" },
  { gid: G(2), title: "Bravo Shoe", vendor: "Adidas", type: "Shoe", tags: ["blue"], price: "40.00" },
  { gid: G(3), title: "Charlie Shoe", vendor: "Puma", type: "Shoe", tags: ["green"], price: "60.00" },
];

function tokenFor(shopId: string, expId: string, split: number, want: "A" | "B"): string {
  for (let i = 0; i < 100000; i++) {
    const tok = "t" + i;
    if (assignVariant(shopId, expId, tok, split) === want) return tok;
  }
  throw new Error("no token found");
}

describe("Phase 8 — merchandising engine", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p8.myshopify.com");
    for (const s of CAT) await seed(db, shop, s);
    await build(db, shop);
  });
  const sf = (params: any) => db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, params));

  it("no rules → baseline unchanged + empty merch fields", async () => {
    const r = await sf({ q: "shoe", nl: false });
    expect(r.products.map((p) => p.title)).toEqual(["Alpha Shoe", "Bravo Shoe", "Charlie Shoe"]); // score tie → title asc
    expect(r.total).toBe(3);
    expect(r.banners).toEqual([]);
    expect(r.experiments).toEqual([]);
    expect(r.merchandising.annotations).toEqual({});
  });

  it("pin: fixed top + stable across pagination; only for relevance", async () => {
    await db.withShopExec(shop, (e) => createRule(e, shop, { action: "pin", scopeType: "query_contains", scopeValue: "shoe", position: 1, targets: [{ kind: "gid", value: G(3) }] }));
    const full = await sf({ q: "shoe", nl: false });
    expect(full.products[0].gid).toBe(G(3)); // Charlie pinned to the top
    expect(full.merchandising.annotations[full.products[0].id].action).toBe("pin");
    // stable across pages: page1(limit1) == first of full; page2 != pinned.
    const p1 = await sf({ q: "shoe", nl: false, limit: 1, offset: 0 });
    const p2 = await sf({ q: "shoe", nl: false, limit: 1, offset: 1 });
    expect(p1.products[0].gid).toBe(G(3));
    expect(p2.products[0].gid).not.toBe(G(3));
    // price sort ignores the pin (explicit user choice), hide-only applies there.
    const byPrice = await sf({ q: "shoe", nl: false, sort: "price_asc" });
    expect(byPrice.products.map((p) => p.gid)).toEqual([G(2), G(1), G(3)]); // 40,50,60 — not pinned
  });

  it("hide: excluded from products, total, facets, predictive, suggestions", async () => {
    await db.withShopExec(shop, (e) => createRule(e, shop, { action: "hide", scopeType: "global", targets: [{ kind: "gid", value: G(1) }] }));
    const r = await sf({ q: "shoe", nl: false });
    expect(r.total).toBe(2);
    expect(r.products.map((p) => p.gid)).not.toContain(G(1));
    const vendor = r.facets.find((f) => f.key === "vendor");
    expect(vendor?.options.find((o) => o.value === "Nike")).toBeUndefined(); // Alpha/Nike hidden
    // predictive excludes the hidden product's title
    const pred = await db.withShopExec(shop, (e) => predictiveWithExec(e, shop, { q: "alpha" }));
    expect(pred.products.map((p) => p.gid)).not.toContain(G(1));
    expect(pred.suggestions.map((s) => s.text)).not.toContain("Alpha Shoe");
  });

  it("pin of a draft / other-shop / unknown product has no effect", async () => {
    await seed(db, shop, { gid: G(99), title: "Draft Shoe", vendor: "Ghost", type: "Shoe", tags: [], price: "5.00", status: "DRAFT" });
    await build(db, shop);
    await db.withShopExec(shop, (e) => createRule(e, shop, { action: "pin", scopeType: "query_contains", scopeValue: "shoe", position: 1, targets: [
      { kind: "gid", value: G(99) }, // draft
      { kind: "gid", value: "gid://shopify/Product/555" }, // unknown
    ] }));
    const r = await sf({ q: "shoe", nl: false });
    expect(r.products.map((p) => p.gid)).not.toContain(G(99)); // draft never surfaces
    expect(r.products[0].gid).not.toBe(G(99));
  });

  it("boost reorders within a class; never outranks an exact-SKU match", async () => {
    // Boost Bravo (title-asc would put it 2nd) to the top among the shoe matches.
    await db.withShopExec(shop, (e) => createRule(e, shop, { action: "boost", scopeType: "query_contains", scopeValue: "shoe", weight: 80, targets: [{ kind: "gid", value: G(2) }] }));
    const r = await sf({ q: "shoe", nl: false });
    expect(r.products[0].gid).toBe(G(2)); // Bravo boosted above Alpha/Charlie

    // SKU dominance: a product matched by SKU outranks a boosted title match.
    const shop2 = await db.resolveShop("p8sku.myshopify.com");
    await seed(db, shop2, { gid: G(10), title: "Gadget", vendor: "V", type: "Thing", tags: [], price: "9", sku: "ABC123" });
    await seed(db, shop2, { gid: G(11), title: "ABC123 Mug", vendor: "V", type: "Thing", tags: [], price: "9", sku: "SKU-OTHER" });
    await build(db, shop2);
    await db.withShopExec(shop2, (e) => createRule(e, shop2, { action: "boost", scopeType: "global", weight: 90, targets: [{ kind: "gid", value: G(11) }] }));
    const r2 = await db.withShopExec(shop2, (e) => storefrontSearchWithExec(e, shop2, { q: "abc123", nl: false }));
    expect(r2.products[0].gid).toBe(G(10)); // SKU hit stays on top despite the +90 boost on G(11)
  });

  it("schedule window is evaluated against a single injected clock", async () => {
    const vid = await db.withShopExec(shop, async (e) => (await e.rows<{ id: string }>(`SELECT id FROM index_version WHERE shop_id=$1::uuid AND status='active'`, [shop]))[0].id);
    await db.withShopExec(shop, (e) => createRule(e, shop, {
      action: "hide", scopeType: "global", targets: [{ kind: "gid", value: G(1) }],
      startsAt: "2026-06-01T00:00:00Z", endsAt: "2026-06-10T00:00:00Z",
    }));
    const before = await db.withShopExec(shop, (e) => loadMerchPlan(e, shop, vid, { q: "shoe", collectionGid: null, now: new Date("2026-05-31T23:59:59Z"), token: null }));
    expect(before.hideIds).toHaveLength(0);
    const during = await db.withShopExec(shop, (e) => loadMerchPlan(e, shop, vid, { q: "shoe", collectionGid: null, now: new Date("2026-06-01T00:00:00Z"), token: null }));
    expect(during.hideIds).toHaveLength(1); // start inclusive
    const atEnd = await db.withShopExec(shop, (e) => loadMerchPlan(e, shop, vid, { q: "shoe", collectionGid: null, now: new Date("2026-06-10T00:00:00Z"), token: null }));
    expect(atEnd.hideIds).toHaveLength(0); // end exclusive
  });

  it("banners: scoped + sanitized payload", async () => {
    await db.withShopExec(shop, (e) => createBanner(e, shop, {
      scopeType: "query_contains", scopeValue: "shoe", title: "Shoe Sale", body: "20% off",
      imageUrl: "https://cdn.shopify.com/s/files/1/banner.jpg?v=1", linkPath: "/collections/shoes",
    }));
    const r = await sf({ q: "red shoe", nl: false });
    expect(r.banners).toHaveLength(1);
    expect(r.banners[0]).toMatchObject({ title: "Shoe Sale", body: "20% off", imageUrl: "https://cdn.shopify.com/s/files/1/banner.jpg?v=1", linkPath: "/collections/shoes" });
    const none = await sf({ q: "hat", nl: false });
    expect(none.banners).toHaveLength(0);
  });

  it("A/B: variant rule only affects its assigned bucket; stop restores default", async () => {
    const expId = await db.withShopExec(shop, (e) => createExperiment(e, shop, { name: "hide-alpha", splitPct: 50 }).then((x) => x.id));
    await db.withShopExec(shop, (e) => setExperimentStatus(e, shop, expId, "running"));
    await db.withShopExec(shop, (e) => createRule(e, shop, { action: "hide", scopeType: "global", experimentId: expId, variant: "B", targets: [{ kind: "gid", value: G(1) }] }));
    const tokB = tokenFor(shop, expId, 50, "B");
    const tokA = tokenFor(shop, expId, 50, "A");

    const bRes = await sf({ q: "shoe", nl: false, visitorToken: tokB });
    expect(bRes.products.map((p) => p.gid)).not.toContain(G(1)); // B sees the hide
    const aRes = await sf({ q: "shoe", nl: false, visitorToken: tokA });
    expect(aRes.products.map((p) => p.gid)).toContain(G(1)); // A = default rule set
    const ctl = await sf({ q: "shoe", nl: false }); // no token → control
    expect(ctl.products.map((p) => p.gid)).toContain(G(1));

    await db.withShopExec(shop, (e) => setExperimentStatus(e, shop, expId, "stopped"));
    const afterStop = await sf({ q: "shoe", nl: false, visitorToken: tokB });
    expect(afterStop.products.map((p) => p.gid)).toContain(G(1)); // stop restores default immediately
  });

  it("A/B exposure/click counters are aggregate; only count for running experiments", async () => {
    const expId = await db.withShopExec(shop, (e) => createExperiment(e, shop, { name: "exp", splitPct: 50 }).then((x) => x.id));
    expect(await db.withShopExec(shop, (e) => recordEvent(e, shop, expId, "B", "exposure"))).toBe(false); // draft → no-op
    await db.withShopExec(shop, (e) => setExperimentStatus(e, shop, expId, "running"));
    await db.withShopExec(shop, (e) => recordEvent(e, shop, expId, "B", "exposure"));
    await db.withShopExec(shop, (e) => recordEvent(e, shop, expId, "B", "exposure"));
    await db.withShopExec(shop, (e) => recordEvent(e, shop, expId, "B", "click"));
    expect(await db.withShopExec(shop, (e) => recordEvent(e, shop, expId, "bogus", "click"))).toBe(false); // bad variant
    const rep = await db.withShopExec(shop, (e) => exposureReport(e, shop));
    const b = rep.find((r) => r.variant === "B");
    expect(b?.exposures).toBe(2);
    expect(b?.clicks).toBe(1);
  });

  it("cross-shop isolation: one shop's rules never affect another; RLS on the tables", async () => {
    await db.withShopExec(shop, (e) => createRule(e, shop, { action: "hide", scopeType: "global", targets: [{ kind: "gid", value: G(1) }] }));
    const other = await db.resolveShop("p8-other.myshopify.com");
    await seed(db, other, { gid: G(1), title: "Alpha Shoe", vendor: "Nike", type: "Shoe", tags: ["red"], price: "50.00" });
    await build(db, other);
    const r = await db.withShopExec(other, (e) => storefrontSearchWithExec(e, other, { q: "shoe", nl: false }));
    expect(r.products.map((p) => p.gid)).toContain(G(1)); // other shop's product not hidden
    const otherRules = await db.withShopExec(other, (e) => listRules(e, other));
    expect(otherRules).toHaveLength(0); // RLS: cannot see shop A's rules
  });

  it("H2: recordEvent rejects malformed/unknown/stopped/bad input without throwing", async () => {
    const expId = await db.withShopExec(shop, (e) => createExperiment(e, shop, { name: "h2", splitPct: 50 }).then((x) => x.id));
    const rec = (id: string, variant: string, type: any) => db.withShopExec(shop, (e) => recordEvent(e, shop, id, variant, type));
    // draft (not running) → false
    expect(await rec(expId, "A", "exposure")).toBe(false);
    await db.withShopExec(shop, (e) => setExperimentStatus(e, shop, expId, "running"));
    // malformed ids / variants / types → false, never throw
    expect(await rec("not-a-uuid", "A", "exposure")).toBe(false);
    expect(await rec("'; DROP TABLE ab_exposure;--", "A", "exposure")).toBe(false);
    expect(await rec("", "A", "exposure")).toBe(false);
    expect(await rec("x".repeat(10000), "A", "exposure")).toBe(false);
    expect(await rec("3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071", "A", "exposure")).toBe(false); // valid uuid, unknown
    expect(await rec(expId, "bogus", "exposure")).toBe(false);
    expect(await rec(expId, "A", "sql")).toBe(false);
    // valid running experiment records
    expect(await rec(expId, "A", "exposure")).toBe(true);
    expect(await rec(expId, "A", "click")).toBe(true);
    // other shop cannot record for this experiment id (RLS → not running there)
    const other = await db.resolveShop("p8-h2-other.myshopify.com");
    expect(await db.withShopExec(other, (e) => recordEvent(e, other, expId, "A", "exposure"))).toBe(false);
    // stop → no longer records
    await db.withShopExec(shop, (e) => setExperimentStatus(e, shop, expId, "stopped"));
    expect(await rec(expId, "A", "exposure")).toBe(false);
  });

  it("H3: pin order is relative (a lone pin order 5 appears first, not slot 5)", async () => {
    await db.withShopExec(shop, (e) => createRule(e, shop, { action: "pin", scopeType: "query_contains", scopeValue: "shoe", position: 5, targets: [{ kind: "gid", value: G(3) }] }));
    const r = await sf({ q: "shoe", nl: false });
    expect(r.products[0].gid).toBe(G(3)); // pinned product is first despite pin order 5
    expect(r.products).toHaveLength(3); // no empty "slots 1–4"
  });
});
