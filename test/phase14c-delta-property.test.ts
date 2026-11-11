import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import type { Exec } from "~/lib/db/executor";
import { createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion, getActiveVersion } from "~/lib/index/engine";
import { rebuildVocabulary } from "~/lib/search/vocabulary";
import { applyProductUpsert, applyProductDeletion } from "~/lib/sync/orchestrator";
import type { NormalizedProduct } from "~/lib/catalog/bulk-parse";

/*
 * Phase 14c W2(a) — PROPERTY TEST. After a long random sequence of writes through
 * the REAL apply paths (which delta-maintain the precomputed structures), the
 * delta-maintained tables must be EXACTLY equal to a fresh full rebuild of the
 * same database state. The 3 counted tables are compared row-for-row; the facet
 * summary compares doc_count and the EFFECTIVE price range (stored when clean,
 * live min/max when price_dirty — the reader's fallback), which must equal a
 * fresh rebuild's (always-exact) price range.
 */

type Row = Record<string, unknown>;
async function dump(e: Exec, shop: string, ver: string) {
  const q = (sql: string) => e.rows<Row>(sql, [shop, ver]);
  return {
    vocab: await q(`SELECT term, doc_freq, is_numeric FROM search_vocabulary WHERE shop_id=$1::uuid AND index_version_id=$2::uuid ORDER BY term`),
    fv: await q(`SELECT kind, value, doc_count FROM search_facet_value WHERE shop_id=$1::uuid AND index_version_id=$2::uuid ORDER BY kind, value`),
    st: await q(`SELECT type, text, doc_count FROM search_suggest_term WHERE shop_id=$1::uuid AND index_version_id=$2::uuid ORDER BY type, text`),
  };
}
// Effective summary = doc_count + (live price range when dirty, else stored).
async function effectiveSummary(e: Exec, shop: string, ver: string) {
  const s = (await e.rows<{ price_min: string | null; price_max: string | null; doc_count: number; price_dirty: boolean }>(
    `SELECT price_min, price_max, doc_count, price_dirty FROM search_facet_summary WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`, [shop, ver]))[0];
  if (!s) return null;
  if (s.price_dirty) {
    const l = (await e.rows<{ mn: string | null; mx: string | null }>(
      `SELECT min(price_min) mn, max(price_max) mx FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published AND status='ACTIVE'`, [shop, ver]))[0];
    return { doc_count: s.doc_count, min: l.mn, max: l.mx };
  }
  return { doc_count: s.doc_count, min: s.price_min, max: s.price_max };
}

// Deterministic PRNG (high bits — low bits of an LCG are not random).
let seed = 123456789;
const rnd = (m: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % m; };
const pick = <T,>(a: T[]) => a[rnd(a.length)];

const VENDORS = ["Nike", "Adidas", "", "Puma", "ACME Co"];
const TYPES = ["Shoe", "Sandal", "", "Boot"];
const TAGS = ["Red", "red", "Sport", "SALE", "new", "", "winter"];
const TITLES = ["Running Shoe", "Trail Runner", "Beach Sandal", "Winter Boot", "Clog", ""];
const MATS = ["Leather", "Rubber", "", "Canvas"];
const COLS = ["gid://shopify/Collection/A", "gid://shopify/Collection/B", "gid://shopify/Collection/C"];

function randomProduct(i: number): NormalizedProduct {
  const gid = `gid://shopify/Product/${i}`;
  const status = rnd(8) === 0 ? "DRAFT" : rnd(8) === 0 ? "ARCHIVED" : "ACTIVE";
  const published = rnd(6) !== 0;
  const tagN = rnd(3);
  const tags = Array.from({ length: tagN }, () => pick(TAGS)).filter((t) => t !== "");
  return {
    product: {
      shopifyProductGid: gid, title: pick(TITLES), handle: `h${i}`, vendor: pick(VENDORS), productType: pick(TYPES),
      status, tags, onlineStoreUrl: published ? `https://x.test/${i}` : null,
      featuredImageUrl: "https://img/x.jpg", featuredImageAlt: "x",
      metafields: rnd(2) ? { "custom.material": pick(MATS) } : {},
      combinedRole: null, combinedParentGid: null,
    },
    variants: [{ shopifyVariantGid: `${gid}/v1`, sku: `S${i}`, price: String(5 + rnd(95)), availableForSale: rnd(4) !== 0, position: 1 }],
    collectionGids: Array.from({ length: rnd(3) }, () => pick(COLS)).filter((v, idx, a) => a.indexOf(v) === idx),
    variantsComplete: true, collectionsComplete: true,
  };
}

describe("Phase 14c W2a — delta maintenance equals a fresh full rebuild", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); seed = 987654321; shop = await db.resolveShop("p14c-prop.myshopify.com"); });

  it("after 250 random ops, all delta tables == fresh rebuild (exact)", async () => {
    const runner = db.withShopExec.bind(db);
    // Seed 20 products + build + activate (full rebuild baseline).
    for (let i = 1; i <= 20; i++) await applyProductUpsert(runner, shop, randomProduct(i));
    const n0 = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
    const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n0));
    await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
    await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n0));
    await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
    const ver = v.id;

    // 250 random ops over a pool of 30 gids (upsert existing/new, or delete).
    for (let op = 0; op < 250; op++) {
      const i = 1 + rnd(30);
      if (rnd(7) === 0) await applyProductDeletion(runner, shop, `gid://shopify/Product/${i}`);
      else await applyProductUpsert(runner, shop, randomProduct(i));
    }

    // Snapshot the delta-maintained state, then full-rebuild and snapshot again.
    const deltaDump = await db.withShopExec(shop, (e) => dump(e, shop, ver));
    const deltaSummary = await db.withShopExec(shop, (e) => effectiveSummary(e, shop, ver));
    await db.withShopExec(shop, (e) => rebuildVocabulary(e, shop, ver));
    const freshDump = await db.withShopExec(shop, (e) => dump(e, shop, ver));
    const freshSummary = await db.withShopExec(shop, (e) => effectiveSummary(e, shop, ver));

    expect(deltaDump.vocab).toEqual(freshDump.vocab);
    expect(deltaDump.fv).toEqual(freshDump.fv);
    expect(deltaDump.st).toEqual(freshDump.st);
    expect(deltaSummary).toEqual(freshSummary);
    // sanity: the comparison was non-trivial
    expect(freshDump.fv.length).toBeGreaterThan(5);
    expect(freshDump.st.length).toBeGreaterThan(5);
  });
});
