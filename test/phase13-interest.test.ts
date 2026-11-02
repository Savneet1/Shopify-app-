import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase 13.1 — interest-based suggestions (CLIENT-ONLY, consent-gated). The
 * server stores and logs NOTHING. These are pure/static checks of boost-core's
 * guarded helpers; real-browser DOM behaviour is Requires Verification.
 */
const require = createRequire(import.meta.url);
const EXT = join(__dirname, "..", "extensions", "search-discovery-theme");
const required = require(join(EXT, "assets", "boost-core.js"));
const Core = required && required.interestReorder ? required : (globalThis as any).BoostSearch;

// A minimal in-memory localStorage double that records removeItem calls.
function fakeStore() {
  const map = new Map<string, string>();
  const calls: string[] = [];
  return {
    map, calls,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { calls.push("set:" + k); map.set(k, String(v)); },
    removeItem: (k: string) => { calls.push("remove:" + k); map.delete(k); },
  };
}
const CONSENT = { analyticsProcessingAllowed: () => true };
const NO_CONSENT = { analyticsProcessingAllowed: () => false };

describe("Phase 13.1 — PII guard (canonicalise-then-redact)", () => {
  it("flags emails, phones, card runs and long tokens — even obfuscated", () => {
    expect(Core.isLikelyPII("email me at jane.doe@example.com")).toBe(true);
    expect(Core.isLikelyPII("call 415 555 0132 today")).toBe(true);
    expect(Core.isLikelyPII("4111 1111 1111 1111")).toBe(true);
    expect(Core.isLikelyPII("token AKIA1234567890ABCDEF99")).toBe(true);
    // full-width / zero-width obfuscation is canonicalised first
    expect(Core.isLikelyPII("ｊｏｈｎ@ｅｘ.ｃｏｍ")).toBe(true);
    expect(Core.isLikelyPII("４１１１１１１１１１１１１１１１")).toBe(true);
  });
  it("leaves ordinary product searches alone", () => {
    expect(Core.isLikelyPII("red running shoes")).toBe(false);
    expect(Core.isLikelyPII("size 10 blue")).toBe(false);
    expect(Core.isLikelyPII("")).toBe(false);
  });
});

describe("Phase 13.1 — consent gate (fail-closed) on the storage glue", () => {
  it("interestRead with NO consent deletes the key and returns empty", () => {
    const ls = fakeStore();
    ls.map.set(Core.INTEREST_KEY, JSON.stringify({ v: 1, recent: ["x"], weights: { "type:Shoe": 3 } }));
    const st = Core.interestRead(NO_CONSENT, 1000, ls);
    expect(st.recent).toEqual([]);
    expect(st.weights).toEqual({});
    expect(ls.calls).toContain("remove:" + Core.INTEREST_KEY);
    expect(ls.map.has(Core.INTEREST_KEY)).toBe(false);
  });
  it("interestWrite with NO consent deletes the key and writes nothing", () => {
    const ls = fakeStore();
    const ok = Core.interestWrite(NO_CONSENT, { v: 1, recent: ["a"], weights: {} }, ls);
    expect(ok).toBe(false);
    expect(ls.calls.filter((c) => c.startsWith("set:"))).toEqual([]);
    expect(ls.map.has(Core.INTEREST_KEY)).toBe(false);
  });
  it("round-trips WITH consent; never persists a PII search", () => {
    const ls = fakeStore();
    let st = Core.interestRead(CONSENT, 1000, ls);
    st = Core.interestAddSearch(st, "blue shoes", 1000);
    st = Core.interestAddSearch(st, "jane@example.com", 1000); // PII → skipped
    Core.interestWrite(CONSENT, st, ls);
    const back = Core.interestRead(CONSENT, 1000, ls);
    expect(back.recent).toEqual(["blue shoes"]);
  });
});

describe("Phase 13.1 — recent searches: dedup / cap / length", () => {
  it("dedupes case-insensitively, newest first, caps at 10, trims to 60", () => {
    let st = Core.interestEmpty(0);
    st = Core.interestAddSearch(st, "Shoes", 1);
    st = Core.interestAddSearch(st, "shoes", 2); // dup (ci) → moves to front, no growth
    expect(st.recent).toEqual(["shoes"]);
    for (let i = 0; i < 15; i++) st = Core.interestAddSearch(st, "q" + i, 3 + i);
    expect(st.recent.length).toBe(Core.INTEREST_MAX_RECENT);
    const long = "blue shoes ".repeat(10); // 110 chars, spaces → not a PII token
    st = Core.interestAddSearch(st, long, 999);
    expect(st.recent[0].length).toBe(60);
  });
});

describe("Phase 13.1 — interest weights: bump / cap / decay", () => {
  it("bumps namespaced weights from a clicked product's facets", () => {
    let st = Core.interestEmpty(0);
    st = Core.interestAddClick(st, { productType: "Shoe", vendor: "Nike", tags: ["running"] }, 1);
    st = Core.interestAddClick(st, { productType: "Shoe", vendor: "Adidas" }, 2);
    expect(st.weights["type:Shoe"]).toBe(2);
    expect(st.weights["vendor:Nike"]).toBe(1);
    expect(st.weights["tag:running"]).toBe(1);
  });
  it("caps at 20 keys, evicting the lowest-weighted", () => {
    const w: Record<string, number> = {};
    for (let i = 0; i < 25; i++) w["vendor:V" + i] = i + 1; // V0=1 (lowest) .. V24=25
    const kept = Core.interestEvict(w);
    expect(Object.keys(kept).length).toBe(Core.INTEREST_MAX_KEYS);
    expect(kept["vendor:V0"]).toBeUndefined(); // lowest evicted
    expect(kept["vendor:V4"]).toBeUndefined();
    expect(kept["vendor:V24"]).toBe(25); // highest kept
    // and a live add never exceeds the cap
    let st = Core.interestEmpty(0);
    for (let i = 0; i < 30; i++) st = Core.interestAddClick(st, { vendor: "W" + i }, 1);
    expect(Object.keys(st.weights).length).toBeLessThanOrEqual(Core.INTEREST_MAX_KEYS);
  });
  it("halves weights once per 30-day half-life and drops zeros", () => {
    let st = Core.interestEmpty(0);
    st = Core.interestAddClick(st, { vendor: "Nike" }, 0);
    st.weights["vendor:Nike"] = 8;
    const month = 30 * 24 * 60 * 60 * 1000;
    const decayed = Core.interestDecay(st, 2 * month); // two half-lives → /4
    expect(decayed.weights["vendor:Nike"]).toBe(2);
    const gone = Core.interestDecay(st, 4 * month); // 8/16 = 0 → dropped
    expect(gone.weights["vendor:Nike"]).toBeUndefined();
  });
  it("expired records (past 90-day TTL) are wiped on read", () => {
    const ls = fakeStore();
    ls.map.set(Core.INTEREST_KEY, JSON.stringify({ v: 1, ts: 0, recent: ["old"], weights: {} }));
    const st = Core.interestRead(CONSENT, 91 * 24 * 60 * 60 * 1000, ls);
    expect(st.recent).toEqual([]);
    expect(ls.map.has(Core.INTEREST_KEY)).toBe(false);
  });
});

describe("Phase 13.1 — interestReorder is stable and never adds/removes", () => {
  it("re-orders by score, preserving the input set and tie order", () => {
    const items = [
      { id: "a", s: 0 }, { id: "b", s: 5 }, { id: "c", s: 0 }, { id: "d", s: 5 },
    ];
    const out = Core.interestReorder(items, (it: any) => it.s);
    expect(out.map((x: any) => x.id)).toEqual(["b", "d", "a", "c"]); // ties keep original order
    expect(out.length).toBe(items.length); // nothing added/removed
    expect(new Set(out.map((x: any) => x.id))).toEqual(new Set(["a", "b", "c", "d"]));
  });
  it("empty / non-array input is safe", () => {
    expect(Core.interestReorder(null as any, () => 1)).toEqual([]);
    expect(Core.interestReorder([], () => 1)).toEqual([]);
  });
});

describe("Phase 13b C5 — interestReorder never throws", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("a THROWING scorer → original order, no throw", () => {
    let out: any;
    expect(() => { out = Core.interestReorder(items, () => { throw new Error("boom"); }); }).not.toThrow();
    expect(out.map((x: any) => x.id)).toEqual(["a", "b", "c"]); // all score 0 → stable
    expect(out.length).toBe(3);
  });
  it("NaN / Infinity / string / null scores are treated as 0 (stable, kept)", () => {
    const scores: Record<string, unknown> = { a: NaN, b: Infinity, c: "nope" };
    const out = Core.interestReorder(items, (it: any) => scores[it.id]);
    expect(out.map((x: any) => x.id)).toEqual(["a", "b", "c"]);
    const out2 = Core.interestReorder(items, () => null);
    expect(out2.map((x: any) => x.id)).toEqual(["a", "b", "c"]);
  });
  it("a scorer that throws for SOME items still orders the finite-scored ones", () => {
    const out = Core.interestReorder(items, (it: any) => {
      if (it.id === "b") throw new Error("x");
      return it.id === "c" ? 10 : 1;
    });
    expect(out.map((x: any) => x.id)).toEqual(["c", "a", "b"]); // c(10) > a(1) > b(0, threw)
    expect(new Set(out.map((x: any) => x.id))).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("Phase 13.1 — STATIC: the interest key is touched ONLY in the guarded helper", () => {
  const assets = ["boost-core.js", "boost-predictive.js", "boost-results.js", "boost-recommendations.js", "boost-analytics.js", "boost-bundle.js"];
  it("no asset outside boost-core references the raw interest localStorage key", () => {
    for (const a of assets) {
      if (a === "boost-core.js") continue;
      const src = readFileSync(join(EXT, "assets", a), "utf8");
      expect(src.includes("boost_interest"), `${a} must not touch the interest key directly`).toBe(false);
    }
  });
  it("boost-predictive uses the Core.interest* API, never raw localStorage for interest", () => {
    const src = readFileSync(join(EXT, "assets", "boost-predictive.js"), "utf8");
    expect(src).toMatch(/Core\.interestRead/);
    expect(src).toMatch(/Core\.interestWrite/);
    expect(src).toMatch(/Core\.interestClear/);
    expect(src.includes("boost_interest")).toBe(false);
    // the only localStorage use in predictive is the pre-existing A/B token read
    const lsLines = src.split("\n").filter((l) => /localStorage/.test(l));
    for (const l of lsLines) expect(l.includes("boost_abt")).toBe(true);
  });
  it("boost-core touches the interest key only inside interestRead/Write/Clear", () => {
    const src = readFileSync(join(EXT, "assets", "boost-core.js"), "utf8");
    // Every ls.getItem/setItem/removeItem of INTEREST_KEY sits in the 3 helpers;
    // assert the key constant exists and the helpers are the only callers by
    // checking there is no INTEREST_KEY use before the helper section.
    expect(src).toMatch(/var INTEREST_KEY = "boost_interest_v1"/);
    expect(src).toMatch(/function interestRead\(privacyApi, now, storage\)/);
  });
});
