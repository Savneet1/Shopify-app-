import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion } from "~/lib/index/engine";
import { recordSignal, trending } from "~/lib/recommend/signals";

/*
 * Phase 9.2 — trending signals + time-decayed score. node-postgres (same SQL as
 * production Prisma). Migration 0011 must be applied to the test DB.
 */
const G = (n: number) => `gid://shopify/Product/${n}`;
const handleOf = (gid: string) => gid.split("/").pop()!;

async function seed(db: TestDb, shop: string, gid: string, title: string, createdAt: string, available = true) {
  await db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: gid, title, handle: handleOf(gid), vendor: "V", productType: "T", tags: [],
      status: "ACTIVE", onlineStoreUrl: `https://shop.example/products/${handleOf(gid)}`,
      featuredImageUrl: `https://cdn.shopify.com/${handleOf(gid)}.jpg`, metafields: {}, productCreatedAt: createdAt,
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: gid + "/v", sku: "S-" + handleOf(gid), price: "10", availableForSale: available });
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

const NOW = new Date("2026-03-15T12:00:00Z");
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86400_000);

describe("Phase 9.2 — trending signals", () => {
  let db: TestDb;
  let shop: string;
  let version: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p9t.myshopify.com");
    await seed(db, shop, G(1), "Alpha", "2024-01-01T00:00:00Z");
    await seed(db, shop, G(2), "Bravo", "2024-06-01T00:00:00Z");
    await seed(db, shop, G(3), "Charlie", "2024-12-01T00:00:00Z"); // newest
    version = await build(db, shop);
  });

  const rec = (ref: unknown, type: unknown, now = NOW) => db.withShopExec(shop, (e) => recordSignal(e, shop, version, ref, type, now));
  const trend = (opts: Partial<Parameters<typeof trending>[3]> = {}) =>
    db.withShopExec(shop, (e) => trending(e, shop, version, { limit: 24, includeOutOfStock: false, hideIds: [], halfLifeDays: 7, now: NOW, ...opts }));

  it("records aggregate view/click counters and nothing else", async () => {
    expect(await rec(G(1), "click")).toBe(true);
    expect(await rec(G(1), "view")).toBe(true);
    const rows = await db.withShopExec(shop, (e) => e.rows<{ views: number; clicks: number }>(
      "SELECT views::int, clicks::int FROM product_signal_daily WHERE shop_id=$1::uuid", [shop]));
    expect(rows.length).toBe(1);
    expect(rows[0].views).toBe(1);
    expect(rows[0].clicks).toBe(1);
    // the table has NO visitor/ip/user columns (aggregate only)
    const cols = await db.withShopExec(shop, (e) => e.rows<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='product_signal_daily'"));
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual(["clicks", "day", "product_id", "shop_id", "updated_at", "views"]);
  });

  it("hostile / junk beacon input is a no-op (never throws, never writes)", async () => {
    for (const [ref, type] of [
      ["'; DROP TABLE product_signal_daily; --", "view"],
      ["gid://shopify/Variant/1", "click"],
      ["x".repeat(500), "view"],
      [G(1), "purchase"],       // unknown type
      [G(9999), "view"],        // unknown product
      [null, "view"],
      [G(1), null],
    ] as [unknown, unknown][]) {
      expect(await rec(ref, type)).toBe(false);
    }
    const n = await db.withShopExec(shop, (e) => e.rows<{ n: number }>("SELECT count(*)::int n FROM product_signal_daily WHERE shop_id=$1::uuid", [shop]));
    expect(n[0].n).toBe(0);
  });

  it("time-decayed score ranks recent clicks over old views (injected clock)", async () => {
    await rec(G(1), "click", NOW);              // age 0 → 3
    await rec(G(2), "view", daysBefore(7));     // age 7, half-life 7 → 0.5
    const out = await trend();
    expect(out[0].gid).toBe(G(1));
    expect(out[0].score).toBeGreaterThan(out[1].score);
    // whole-day decay: Alpha age 0 → 3·1 = 3; Bravo age 7, half-life 7 → 1·0.5
    expect(out[0].score).toBeCloseTo(3, 6);
    const bravo = out.find((p) => p.gid === G(2))!;
    expect(bravo.score).toBeCloseTo(0.5, 6);
  });

  it("tops up with newest when signals cover fewer than the limit", async () => {
    await rec(G(1), "click");
    const out = await trend({ limit: 3 });
    expect(out.length).toBe(3);
    expect(out[0].gid).toBe(G(1));             // the only signalled product leads
    // remainder is newest-first (Charlie 2024-12 before Bravo 2024-06), excluding Alpha
    expect(out.slice(1).map((p) => p.gid)).toEqual([G(3), G(2)]);
  });

  it("no signals at all → full newest-visible fallback (deterministic)", async () => {
    const out = await trend({ limit: 3 });
    expect(out.map((p) => p.gid)).toEqual([G(3), G(2), G(1)]); // newest → oldest
    expect(out.every((p) => p.score === 0)).toBe(true);
  });

  // ---- K1: signal window (stale signals must not outrank fresh content) ----
  it("a stale-only signal does not rank its product above newer content", async () => {
    // Alpha (oldest product) gets one very old click; half-life 7 → window 56d.
    await rec(G(1), "click", new Date("2024-01-01T00:00:00Z"));
    const out = await trend({ limit: 3 });
    // Alpha is excluded from the scored set → shelf is the newest-visible order,
    // so the decayed-to-nothing Alpha is NOT lifted above newer products.
    expect(out.map((p) => p.gid)).toEqual([G(3), G(2), G(1)]);
    expect(out.every((p) => p.score === 0)).toBe(true);
  });

  it("window edge: a row at the cutoff is counted, one day older is not", async () => {
    // halfLife 7 → window 56 → cutoff day = NOW(UTC) − 56.
    await rec(G(2), "click", daysBefore(56)); // Bravo: exactly at the edge → counted
    await rec(G(1), "click", daysBefore(57)); // Alpha: one day too old → excluded
    const out = await trend({ limit: 3 });
    expect(out[0].gid).toBe(G(2));             // Bravo scored (in-window)
    expect(out[0].score).toBeGreaterThan(0);
    // Alpha is not scored; it only appears via the newest top-up (score 0).
    const alpha = out.find((p) => p.gid === G(1))!;
    expect(alpha.score).toBe(0);
  });

  it("half-life scales the window per WINDOW_DAYS = min(90, 8×halfLife)", async () => {
    // A signal 10 days before NOW.
    await rec(G(2), "click", daysBefore(10));
    // halfLife 1 → window 8 → the 10-day-old row is OUT of window → not scored.
    const short = await trend({ limit: 3, halfLifeDays: 1 });
    expect(short.find((p) => p.gid === G(2))!.score).toBe(0);
    // halfLife 7 → window 56 → the same row is IN window → scored.
    const long = await trend({ limit: 3, halfLifeDays: 7 });
    expect(long[0].gid).toBe(G(2));
    expect(long[0].score).toBeGreaterThan(0);
  });

  it("excludes out-of-stock by default and respects hide", async () => {
    await seed(db, shop, G(4), "Delta", "2025-01-01T00:00:00Z", false); // OOS, newest
    version = await build(db, shop);
    await rec(G(4), "click");
    const def = await trend({ limit: 24 });
    expect(def.find((p) => p.gid === G(4))).toBeUndefined(); // OOS excluded
    const incl = await trend({ limit: 24, includeOutOfStock: true });
    expect(incl.find((p) => p.gid === G(4))).toBeTruthy();
    // hide G(3)
    const hid = await trend({ limit: 24, hideIds: [] }); // baseline
    const g3 = hid.find((p) => p.gid === G(3))!;
    const hidden = await trend({ limit: 24, hideIds: [g3.id] });
    expect(hidden.find((p) => p.id === g3.id)).toBeUndefined();
  });
});
