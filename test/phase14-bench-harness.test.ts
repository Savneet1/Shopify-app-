import { describe, it, expect } from "vitest";
import { generateCatalog, mulberry32 } from "../scripts/bench/gen";
import { percentile, summarize } from "../scripts/bench/percentiles";

/*
 * Phase 14.1 — self-tests for the benchmark harness itself (pure, no DB): the
 * synthetic generator is deterministic for a fixed seed, and the percentile math
 * is correct. The DB-driven harness is run via `npm run bench`, not here.
 */

describe("Phase 14.1 — generator determinism", () => {
  it("same seed → byte-identical output; different seed → different", () => {
    const a = generateCatalog({ size: 300, seed: 42 });
    const b = generateCatalog({ size: 300, seed: 42 });
    const c = generateCatalog({ size: 300, seed: 43 });
    expect(a.productsJsonl).toBe(b.productsJsonl);
    expect(a.collectionsJsonl).toBe(b.collectionsJsonl);
    expect(a.productsJsonl).not.toBe(c.productsJsonl);
  });
  it("produces at least `size` products and valid JSONL lines", () => {
    const g = generateCatalog({ size: 500, seed: 7 });
    expect(g.productCount).toBeGreaterThanOrEqual(500);
    for (const line of g.productsJsonl.split("\n").slice(0, 50)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // the visibility + combined slices are all present at this size
    expect(g.stats.draft).toBeGreaterThan(0);
    expect(g.stats.archived).toBeGreaterThan(0);
    expect(g.stats.unpublished).toBeGreaterThan(0);
    expect(g.stats.unavailable).toBeGreaterThan(0);
    expect(g.stats.combinedParents).toBeGreaterThan(0);
    expect(g.stats.combinedChildren).toBeGreaterThan(0);
  });
  it("combined children reference a real parent gid via combinedListing", () => {
    const g = generateCatalog({ size: 500, seed: 7 });
    const lines = g.productsJsonl.split("\n").map((l) => JSON.parse(l));
    const parents = new Set(lines.filter((o) => o.combinedListingRole === "PARENT").map((o) => o.id));
    const children = lines.filter((o) => o.combinedListingRole === "CHILD");
    expect(children.length).toBeGreaterThan(0);
    for (const c of children) expect(parents.has(c.combinedListing.parentProduct.id)).toBe(true);
  });
  it("mulberry32 is stable for a seed", () => {
    const r1 = mulberry32(1); const r2 = mulberry32(1);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});

describe("Phase 14.1 — percentile math", () => {
  it("nearest-rank percentiles on 1..100", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 99)).toBe(99);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 100)).toBe(100);
  });
  it("summarize handles empty + single", () => {
    expect(summarize([])).toMatchObject({ n: 0, p95: 0 });
    expect(summarize([5])).toMatchObject({ n: 1, min: 5, max: 5, p50: 5, p95: 5 });
  });
  it("summarize computes min/max/mean", () => {
    const s = summarize([10, 20, 30, 40]);
    expect(s.min).toBe(10); expect(s.max).toBe(40); expect(s.mean).toBe(25);
  });
});
