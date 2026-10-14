import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { saveAnalyticsSettings } from "~/lib/analytics/settings";
import { ingestEvents } from "~/lib/analytics/store";
import { compareArms, variantStats } from "~/lib/analytics/abtest";

/*
 * Phase 11.5 — A/B readout computed from the event stream's experiment/variant
 * tags (engine-level: seed real events, aggregate per variant, run the gate).
 */
const EXP = "3f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071";
const NOW = new Date("2026-10-15T12:00:00Z");

async function perVariantCounts(db: TestDb, shop: string) {
  return db.withShopExec(shop, (e) => e.rows<{ variant: string; searches: number; clicks: number }>(
    `SELECT variant,
       count(*) FILTER (WHERE event_type='search_performed')::int AS searches,
       count(*) FILTER (WHERE event_type IN ('result_click','predictive_click','suggestion_click','recommendation_click'))::int AS clicks
     FROM analytics_event WHERE shop_id=$1::uuid AND experiment_id=$2::uuid AND variant IS NOT NULL
     GROUP BY variant ORDER BY variant`,
    [shop, EXP],
  ));
}

describe("Phase 11 — A/B readout over events", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shop = await db.resolveShop("p11ab.myshopify.com");
    await db.withShopExec(shop, (e) => saveAnalyticsSettings(e, shop, { mode: "anonymous" }));
  });

  async function seed(variant: string, searches: number, clicks: number) {
    const batch: unknown[] = [];
    for (let i = 0; i < searches; i++) batch.push({ eventType: "search_performed", surface: "search_page", experimentId: EXP, variant });
    for (let i = 0; i < clicks; i++) batch.push({ eventType: "result_click", surface: "search_page", experimentId: EXP, variant, productGid: "gid://shopify/Product/1" });
    // ingest in chunks of 20 (batch cap)
    for (let i = 0; i < batch.length; i += 20) {
      await db.withShopExec(shop, (e) => ingestEvents(e, shop, batch.slice(i, i + 20), NOW));
    }
  }

  it("aggregates per-variant stats and returns a significant z above threshold", async () => {
    await seed("A", 200, 20);  // CTR 10%
    await seed("B", 200, 60);  // CTR 30%
    const rows = await perVariantCounts(db, shop);
    const a = rows.find((r) => r.variant === "A")!;
    const b = rows.find((r) => r.variant === "B")!;
    expect(a.searches).toBe(200);
    expect(b.clicks).toBe(60);
    const sa = variantStats("A", a.searches, a.clicks, 0);
    const sb = variantStats("B", b.searches, b.clicks, 0);
    expect(sa.ctr).toBeCloseTo(0.1, 6);
    expect(sb.ctr).toBeCloseTo(0.3, 6);
    const cmp = compareArms({ successes: b.clicks, trials: b.searches }, { successes: a.clicks, trials: a.searches });
    expect(cmp.verdict).toBe("significant");
  });

  it("below the sample threshold → inconclusive", async () => {
    await seed("A", 30, 3);
    await seed("B", 30, 9);
    const rows = await perVariantCounts(db, shop);
    const a = rows.find((r) => r.variant === "A")!;
    const b = rows.find((r) => r.variant === "B")!;
    const cmp = compareArms({ successes: b.clicks, trials: b.searches }, { successes: a.clicks, trials: a.searches });
    expect(cmp.verdict).toBe("inconclusive_sample");
    expect(cmp.note).toMatch(/not enough data/);
  });
});
