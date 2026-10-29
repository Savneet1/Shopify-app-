import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";
import {
  resolveLocale, localeDir, baseLanguage, isSupportedLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE,
} from "~/lib/i18n/locales";
import { listSynonymsForLocale, addSynonym } from "~/lib/search/synonyms";
import { getEffectiveStopwords, addStopwordOverride } from "~/lib/search/stopwords";
import { matchRedirect, addRedirect } from "~/lib/search/redirects";

/*
 * Phase 13.2 — i18n: pure locale resolver (hostile input) + DB locale scoping of
 * synonyms / stop words / redirects. Migration 0019 applied. Global (NULL) rows
 * always apply; locale-specific rows apply only for the matching locale; with no
 * locale rows the behaviour is byte-identical to pre-13.2.
 */

describe("Phase 13.2 — resolveLocale (exact → base → default)", () => {
  it("exact match (case-insensitive)", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("AR")).toBe("ar");
    expect(resolveLocale("pt-BR")).toBe("pt-BR");
    expect(resolveLocale("PT-br")).toBe("pt-BR");
  });
  it("base-language fallback", () => {
    expect(resolveLocale("pt")).toBe("pt-BR");
    expect(resolveLocale("pt-PT")).toBe("pt-BR");
    expect(resolveLocale("de-AT")).toBe("de");
    expect(resolveLocale("es-MX")).toBe("es");
  });
  it("unknown / hostile → default", () => {
    for (const v of ["", "   ", "zz", "klingon", "x".repeat(50), 42, null, undefined, {}, ["en"]]) {
      expect(resolveLocale(v as unknown)).toBe(DEFAULT_LOCALE);
    }
  });
  it("localeDir: ar is rtl, everything else ltr", () => {
    expect(localeDir("ar")).toBe("rtl");
    expect(localeDir("en")).toBe("ltr");
    expect(localeDir("ja")).toBe("ltr");
    expect(localeDir("unknown")).toBe("ltr");
  });
  it("manifest invariants: 9 locales, exactly one rtl, en is the source", () => {
    expect(SUPPORTED_LOCALES.length).toBe(9);
    expect(SUPPORTED_LOCALES.filter((l) => l.dir === "rtl").map((l) => l.code)).toEqual(["ar"]);
    expect(SUPPORTED_LOCALES.find((l) => l.review === "source")?.code).toBe("en");
    expect(isSupportedLocale("pt-BR")).toBe(true);
    expect(isSupportedLocale("pt")).toBe(false);
    expect(baseLanguage("pt-BR")).toBe("pt");
  });
});

describe("Phase 13.2 — DB locale scoping", () => {
  let db: TestDb; let shop: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => { await db.resetDb(); shop = await db.resolveShop("p13i18n.myshopify.com"); });

  it("synonyms: global rows always apply; locale rows only for that locale", async () => {
    await db.withShopExec(shop, async (e) => {
      await e.run(`INSERT INTO search_synonym (shop_id, kind, from_term, terms, locale) VALUES ($1::uuid,'two_way',NULL,ARRAY['sneaker','trainer'],NULL)`, [shop]);
      await e.run(`INSERT INTO search_synonym (shop_id, kind, from_term, terms, locale) VALUES ($1::uuid,'two_way',NULL,ARRAY['jumper','pullover'],'en')`, [shop]);
      await e.run(`INSERT INTO search_synonym (shop_id, kind, from_term, terms, locale) VALUES ($1::uuid,'two_way',NULL,ARRAY['scarpa','sneaker'],'it')`, [shop]);
    });
    const en = await db.withShopExec(shop, (e) => listSynonymsForLocale(e, shop, "en"));
    const it = await db.withShopExec(shop, (e) => listSynonymsForLocale(e, shop, "it"));
    const none = await db.withShopExec(shop, (e) => listSynonymsForLocale(e, shop, null));
    expect(en.length).toBe(2); // global + en
    expect(it.length).toBe(2); // global + it
    expect(none.length).toBe(1); // only global
    expect(en.some((r) => r.terms.includes("pullover"))).toBe(true);
    expect(en.some((r) => r.terms.includes("scarpa"))).toBe(false);
  });

  it("byte-identical: with only global rows, every locale sees the same set", async () => {
    await db.withShopExec(shop, (e) => addSynonym(e, shop, { kind: "two_way", terms: ["red", "crimson"] }));
    const a = await db.withShopExec(shop, (e) => listSynonymsForLocale(e, shop, "en"));
    const b = await db.withShopExec(shop, (e) => listSynonymsForLocale(e, shop, "ar"));
    const c = await db.withShopExec(shop, (e) => listSynonymsForLocale(e, shop, null));
    expect(a.length).toBe(1); expect(b.length).toBe(1); expect(c.length).toBe(1);
  });

  it("stop words: locale-scoped add; effective set merges global + locale", async () => {
    await db.withShopExec(shop, (e) => addStopwordOverride(e, shop, "the", "add", null)); // global
    await db.withShopExec(shop, (e) => addStopwordOverride(e, shop, "le", "add", "fr")); // fr-only
    const fr = await db.withShopExec(shop, (e) => getEffectiveStopwords(e, shop, "fr"));
    const en = await db.withShopExec(shop, (e) => getEffectiveStopwords(e, shop, "en"));
    expect(fr.has("the")).toBe(true); expect(fr.has("le")).toBe(true);
    expect(en.has("the")).toBe(true); expect(en.has("le")).toBe(false);
  });

  it("redirects: a locale-specific redirect wins over the global one", async () => {
    await db.withShopExec(shop, (e) => addRedirect(e, shop, "sale", "https://p13i18n.myshopify.com/collections/sale", null));
    await db.withShopExec(shop, (e) => addRedirect(e, shop, "sale", "https://p13i18n.myshopify.com/collections/soldes", "fr"));
    const fr = await db.withShopExec(shop, (e) => matchRedirect(e, shop, "sale", "fr"));
    const en = await db.withShopExec(shop, (e) => matchRedirect(e, shop, "sale", "en"));
    const none = await db.withShopExec(shop, (e) => matchRedirect(e, shop, "sale", null));
    expect(fr).toMatch(/soldes/);
    expect(en).toMatch(/\/sale$/); // falls back to the global redirect
    expect(none).toMatch(/\/sale$/);
  });
});

describe("Phase 13.2 — cross-shop isolation of locale-scoped rows", () => {
  let db: TestDb; let a: string; let b: string;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    a = await db.resolveShop("p13ia.myshopify.com");
    b = await db.resolveShop("p13ib.myshopify.com");
  });
  it("shop B never sees shop A's locale-scoped synonyms", async () => {
    await db.withShopExec(a, (e) => addSynonym(e, a, { kind: "two_way", terms: ["aaa", "bbb"] }));
    const bRows = await db.withShopExec(b, (e) => listSynonymsForLocale(e, b, "en"));
    expect(bRows.length).toBe(0);
  });
});
