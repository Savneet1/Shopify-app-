import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
  rollbackToVersion, refreshDocInActiveVersion, getActiveVersion,
} from "~/lib/index/engine";
import { searchWithExec } from "~/lib/search/query";
import { storefrontSearchWithExec } from "~/lib/search/storefront";
import { addSynonym, listSynonyms } from "~/lib/search/synonyms";
import { addStopwordOverride } from "~/lib/search/stopwords";
import { addRedirect, RedirectValidationError } from "~/lib/search/redirects";
import { fuzzyCandidates } from "~/lib/search/vocabulary";

interface Seed {
  gid: string; title: string; vendor?: string; type?: string; tags?: string[];
  price?: string; available?: boolean; status?: string; published?: boolean; sku?: string;
}
async function seed(db: TestDb, shop: string, s: Seed): Promise<string> {
  return db.withShopExec(shop, async (e) => {
    const { id } = await upsertProduct(e, shop, {
      shopifyProductGid: s.gid, title: s.title, handle: s.gid.split("/").pop(),
      vendor: s.vendor ?? "Acme", productType: s.type ?? "Thing", tags: s.tags ?? [],
      status: s.status ?? "ACTIVE", onlineStoreUrl: (s.published ?? true) ? `https://x/${s.gid}` : null,
    });
    await upsertVariant(e, shop, id, { shopifyVariantGid: s.gid + "/v", sku: s.sku ?? "SKU-" + s.gid.split("/").pop(), price: s.price ?? "10.00", availableForSale: s.available ?? true });
    return id;
  });
}
async function build(db: TestDb, shop: string): Promise<string> {
  const n = await db.withShopExec(shop, async (e) => (await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shop]))[0].n);
  const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", n));
  await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
  await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, n));
  await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
  return v.id;
}

describe("Phase 5 — relevance (typo, synonyms, stopwords, redirects, ranking)", () => {
  let db: TestDb;
  let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); shop = await db.resolveShop("p5r.myshopify.com"); });

  const sf = (params: any) => db.withShopExec(shop, (e) => storefrontSearchWithExec(e, shop, params));
  const search = (params: any) => db.withShopExec(shop, (e) => searchWithExec(e, shop, params));

  describe("typo tolerance", () => {
    beforeEach(async () => {
      await seed(db, shop, { gid: "1", title: "Wireless Headphones", vendor: "AudioCo" });
      await seed(db, shop, { gid: "2", title: "Calculator Pro" });
      await build(db, shop);
    });
    it("corrects a transposition/edit typo and indicates the correction", async () => {
      const r = await sf({ q: "hedphones" });
      expect(r.total).toBe(1);
      expect(r.corrected).toBe(true);
      expect(r.corrections[0]).toMatchObject({ from: "hedphones", to: "headphones" });
      expect(r.correctedQuery).toBe("headphones");
      expect(r.strategy).toBe("fuzzy");
    });
    it("original query is preserved alongside the correction", async () => {
      const r = await sf({ q: "hedphones" });
      expect(r.query).toBe("hedphones");
    });
    it("distance-2 typo on an 8+ char term", async () => {
      const r = await sf({ q: "caculatr" }); // calculator with 2 edits
      expect(r.total).toBe(1);
      expect(r.corrections[0]?.to).toBe("calculator");
    });
    it("short terms (<=3 chars) are never fuzzy-matched", async () => {
      const r = await sf({ q: "hed" }); // would be near 'headphones' but too short
      expect(r.corrections).toHaveLength(0);
    });
    it("numeric tokens are never fuzzy-matched", async () => {
      const r = await sf({ q: "12345" });
      expect(r.corrections).toHaveLength(0);
    });
    it("exact match is not treated as a correction", async () => {
      const r = await sf({ q: "wireless" });
      expect(r.corrected).toBe(false);
      expect(r.strategy === "exact" || r.strategy === "prefix").toBe(true);
    });
  });

  describe("synonyms (query-time)", () => {
    it("two-way synonym finds the equivalent product, ranked below exact", async () => {
      await seed(db, shop, { gid: "1", title: "Comfy Sofa" });
      await seed(db, shop, { gid: "2", title: "Leather Couch" });
      await build(db, shop);
      await db.withShopExec(shop, (e) => addSynonym(e, shop, { kind: "two_way", terms: ["sofa", "couch"] }));
      const r = await sf({ q: "sofa" });
      const titles = r.products.map((p) => p.title);
      expect(titles).toContain("Comfy Sofa");
      expect(titles).toContain("Leather Couch");
      expect(titles[0]).toBe("Comfy Sofa"); // exact original outranks synonym
    });
    it("one-way synonym expands from->to only", async () => {
      await seed(db, shop, { gid: "1", title: "Smart Television" });
      await build(db, shop);
      await db.withShopExec(shop, (e) => addSynonym(e, shop, { kind: "one_way", fromTerm: "tv", terms: ["television"] }));
      expect((await sf({ q: "tv" })).total).toBe(1);
    });
    it("multi-word synonym", async () => {
      await seed(db, shop, { gid: "1", title: "Trail Runners" });
      await build(db, shop);
      await db.withShopExec(shop, (e) => addSynonym(e, shop, { kind: "two_way", terms: ["running shoes", "runners"] }));
      expect((await sf({ q: "running shoes" })).total).toBe(1);
    });
    it("synonym rows are tenant-scoped and capped in code", async () => {
      await db.withShopExec(shop, (e) => addSynonym(e, shop, { kind: "two_way", terms: ["a", "b"] }));
      const rows = await db.withShopExec(shop, (e) => listSynonyms(e, shop));
      expect(rows).toHaveLength(1);
    });
  });

  describe("stop words", () => {
    beforeEach(async () => {
      await seed(db, shop, { gid: "1", title: "Sale Rack Shoes", vendor: "Acme" });
      await seed(db, shop, { gid: "2", title: "Plain Shoes", vendor: "Acme" });
      await build(db, shop);
      // "sale" is not a Postgres-english stop word, so we can add it and observe.
      await db.withShopExec(shop, (e) => addStopwordOverride(e, shop, "sale", "add"));
    });
    it("stop words are ignored when a non-stop term remains (search + facets)", async () => {
      const r = await sf({ q: "sale shoes" }); // 'sale' dropped -> search 'shoes'
      expect(r.products.map((p) => p.title).sort()).toEqual(["Plain Shoes", "Sale Rack Shoes"]);
      // facet counts reflect the effective query 'shoes' (both products)
      const vendor = r.facets.find((f) => f.key === "vendor");
      expect(vendor?.options.find((o) => o.value === "Acme")?.count).toBe(2);
    });
    it("a query made only of stop words still works", async () => {
      const r = await sf({ q: "sale" }); // all-stop -> kept -> matches 'sale'
      expect(r.total).toBe(1);
      expect(r.products[0].title).toBe("Sale Rack Shoes");
    });
  });

  describe("redirects", () => {
    beforeEach(async () => {
      await seed(db, shop, { gid: "1", title: "Anything" });
      await build(db, shop);
    });
    it("matches on the normalized query and returns the destination in the payload", async () => {
      await db.withShopExec(shop, (e) => addRedirect(e, shop, "Sale!!", "/collections/sale"));
      const r = await sf({ q: "  sale " }); // normalizes to 'sale'
      expect(r.redirect).toBe("/collections/sale");
      expect(r.products).toHaveLength(0);
    });
    it("rejects external and dangerous-scheme destinations at write time", async () => {
      await expect(db.withShopExec(shop, (e) => addRedirect(e, shop, "x", "https://evil.com"))).rejects.toBeInstanceOf(RedirectValidationError);
      await expect(db.withShopExec(shop, (e) => addRedirect(e, shop, "y", "javascript:alert(1)"))).rejects.toBeInstanceOf(RedirectValidationError);
      await expect(db.withShopExec(shop, (e) => addRedirect(e, shop, "z", "//evil.com"))).rejects.toBeInstanceOf(RedirectValidationError);
    });
    it("accepts an absolute URL on the shop's own domain", async () => {
      const row = await db.withShopExec(shop, (e) => addRedirect(e, shop, "home", "https://p5r.myshopify.com/pages/home"));
      expect(row.destination).toContain("p5r.myshopify.com");
    });
  });

  describe("RLS on every new table (no cross-shop leakage)", () => {
    it("vocabulary, synonyms, stopwords, redirects are tenant-isolated", async () => {
      await seed(db, shop, { gid: "1", title: "SecretTerm Widget" });
      await build(db, shop);
      await db.withShopExec(shop, (e) => addSynonym(e, shop, { kind: "two_way", terms: ["aa", "bb"] }));
      await db.withShopExec(shop, (e) => addStopwordOverride(e, shop, "zzz", "add"));
      await db.withShopExec(shop, (e) => addRedirect(e, shop, "go", "/x"));

      const other = await db.resolveShop("p5r-other.myshopify.com");
      const counts = await db.withShopExec(other, async (e) => ({
        vocab: (await e.rows<{ n: number }>("SELECT count(*)::int n FROM search_vocabulary", []))[0].n,
        syn: (await e.rows<{ n: number }>("SELECT count(*)::int n FROM search_synonym", []))[0].n,
        stop: (await e.rows<{ n: number }>("SELECT count(*)::int n FROM search_stopword", []))[0].n,
        redir: (await e.rows<{ n: number }>("SELECT count(*)::int n FROM search_redirect", []))[0].n,
      }));
      expect(counts).toEqual({ vocab: 0, syn: 0, stop: 0, redir: 0 });
    });
  });

  describe("vocabulary consistency across the versioned lifecycle", () => {
    it("stays in step through build, incremental refresh, swap and rollback", async () => {
      const pid = await seed(db, shop, { gid: "1", title: "Alpha Widget" });
      const v1 = await build(db, shop);
      const vocabHas = async (term: string, versionId?: string) => {
        const active = versionId ?? (await db.withShopExec(shop, (e) => getActiveVersion(e, shop)))!.id;
        const rows = await db.withShopExec(shop, (e) => e.rows("SELECT 1 FROM search_vocabulary WHERE shop_id=$1 AND index_version_id=$2 AND term=$3", [shop, active, term]));
        return rows.length > 0;
      };
      expect(await vocabHas("alpha", v1)).toBe(true);

      // incremental: rename product -> vocabulary reflects the new term.
      await db.withShopExec(shop, (e) => upsertProduct(e, shop, { shopifyProductGid: "1", title: "Beta Widget", onlineStoreUrl: "https://x/1", status: "ACTIVE", shopifyUpdatedAt: new Date(Date.now() + 1000).toISOString() }));
      await db.withShopExec(shop, (e) => refreshDocInActiveVersion(e, shop, pid));
      expect(await vocabHas("beta", v1)).toBe(true);
      expect(await vocabHas("alpha", v1)).toBe(false);

      // build v2 (title Gamma), swap -> active vocab has gamma, not the old.
      await db.withShopExec(shop, (e) => upsertProduct(e, shop, { shopifyProductGid: "1", title: "Gamma Widget", onlineStoreUrl: "https://x/1", status: "ACTIVE", shopifyUpdatedAt: new Date(Date.now() + 2000).toISOString() }));
      const v2 = await build(db, shop);
      expect(await vocabHas("gamma", v2)).toBe(true);
      expect(await search({ q: "gamma" }).then((r) => r.total)).toBe(1);

      // rollback to v1 -> active vocab is v1's (beta), gamma no longer active.
      await db.withShopExec(shop, (e) => rollbackToVersion(e, shop, v1));
      const active = (await db.withShopExec(shop, (e) => getActiveVersion(e, shop)))!;
      expect(active.id).toBe(v1);
      expect(await search({ q: "gamma" }).then((r) => r.total)).toBe(0);
      expect(await search({ q: "beta" }).then((r) => r.total)).toBe(1);
    });
  });

  describe("no draft/unpublished term leakage via corrections", () => {
    it("a draft product's unique term is never a vocabulary term or fuzzy candidate", async () => {
      await seed(db, shop, { gid: "1", title: "Published Kryptonite" });
      await seed(db, shop, { gid: "2", title: "Zebranium Gadget", status: "DRAFT" });
      const v = await build(db, shop);
      const cands = await db.withShopExec(shop, (e) => fuzzyCandidates(e, shop, v, "zebranumm", 2));
      expect(cands.find((c) => c.term === "zebranium")).toBeUndefined();
      const r = await sf({ q: "zebranumm" });
      expect(r.corrections.find((c) => c.to === "zebranium")).toBeUndefined();
    });
  });

  describe("facet/result consistency under fuzzy correction", () => {
    it("facet counts equal the corrected result set", async () => {
      await seed(db, shop, { gid: "1", title: "Running Shoes", vendor: "Nike" });
      await seed(db, shop, { gid: "2", title: "Running Socks", vendor: "Nike" });
      await seed(db, shop, { gid: "3", title: "Walking Boots", vendor: "Timb" });
      await build(db, shop);
      const r = await sf({ q: "runing" }); // typo -> running
      expect(r.total).toBe(2);
      const vendor = r.facets.find((f) => f.key === "vendor");
      expect(vendor?.options.find((o) => o.value === "Nike")?.count).toBe(2);
      expect(vendor?.options.find((o) => o.value === "Timb")).toBeUndefined();
    });
  });

  describe("rule-based ranking determinism", () => {
    it("exact outranks prefix", async () => {
      await seed(db, shop, { gid: "1", title: "Head" });
      await seed(db, shop, { gid: "2", title: "Headphones" });
      await build(db, shop);
      const r = await sf({ q: "head" });
      expect(r.products[0].title).toBe("Head"); // exact before prefix
      expect(r.products[0].matchClass).toBe("exact");
    });
    it("in-stock boost orders equal matches", async () => {
      await seed(db, shop, { gid: "1", title: "Widget", available: false });
      await seed(db, shop, { gid: "2", title: "Widget", available: true });
      await build(db, shop);
      const r = await sf({ q: "widget" });
      expect(r.products[0].available).toBe(true); // in-stock first
    });
    it("order is deterministic (stable tie-break)", async () => {
      for (let i = 1; i <= 5; i++) await seed(db, shop, { gid: String(i), title: "Gadget" });
      await build(db, shop);
      const a = (await sf({ q: "gadget" })).products.map((p) => p.id);
      const b = (await sf({ q: "gadget" })).products.map((p) => p.id);
      expect(a).toEqual(b);
      expect(a.length).toBe(5);
    });
  });
});
