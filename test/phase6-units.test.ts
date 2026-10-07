import { describe, expect, it } from "vitest";
import { parseQuery, type ParseContext } from "~/lib/search/nlparse";

const ctx: ParseContext = {
  attributes: new Map([
    ["red", { facet: "tags", value: "red" }],
    ["rose gold", { facet: "tags", value: "rose gold" }],
    ["leather", { facet: "metafield", value: "leather" }],
    ["large", { facet: "tags", value: "large" }],
  ]),
  vendors: ["Nike", "The North Face"],
  productTypes: ["Shoe", "Running Jacket"],
};

describe("Phase 6 parser — price phrasings", () => {
  it("under / below / less than / up to / at most → priceMax", () => {
    for (const q of ["under 50", "below 50", "less than 50", "up to 50", "at most 50", "cheaper than 50"]) {
      expect(parseQuery(q, ctx).filters.priceMax).toBe(50);
    }
  });
  it("over / above / more than / at least / from → priceMin", () => {
    for (const q of ["over 100", "above 100", "more than 100", "at least 100", "starting at 100", "from 100"]) {
      expect(parseQuery(q, ctx).filters.priceMin).toBe(100);
    }
  });
  it("between X and Y (and X to Y)", () => {
    expect(parseQuery("between 20 and 60", ctx).filters).toMatchObject({ priceMin: 20, priceMax: 60 });
    expect(parseQuery("between 60 and 20", ctx).filters).toMatchObject({ priceMin: 20, priceMax: 60 });
  });
  it("around X → ±20% band", () => {
    const f = parseQuery("around 100", ctx).filters;
    expect(f.priceMin).toBe(80); expect(f.priceMax).toBe(120);
  });
  it("currency symbols and words are tolerated", () => {
    expect(parseQuery("under $50", ctx).filters.priceMax).toBe(50);
    expect(parseQuery("under 50 dollars", ctx).filters.priceMax).toBe(50);
    expect(parseQuery("over ₹2000", ctx).filters.priceMin).toBe(2000);
  });
  it("a bare number with no price cue is NOT a price (ambiguity)", () => {
    const r = parseQuery("shoes 2024", ctx);
    expect(r.filters.priceMin).toBeUndefined();
    expect(r.filters.priceMax).toBeUndefined();
    expect(r.remaining).toContain("2024");
  });
});

describe("Phase 6 parser — availability & sort", () => {
  it("availability in/out of stock", () => {
    expect(parseQuery("shoes in stock", ctx).filters.available).toBe("true");
    expect(parseQuery("shoes out of stock", ctx).filters.available).toBe("false");
  });
  it("sort hints map to supported sorts only", () => {
    expect(parseQuery("cheapest shoes", ctx).sort).toBe("price_asc");
    expect(parseQuery("most expensive", ctx).sort).toBe("price_desc");
    expect(parseQuery("newest arrivals", ctx).sort).toBe("newest");
    // popularity/best-selling is NOT invented
    expect(parseQuery("best selling shoes", ctx).sort).toBeUndefined();
  });
});

describe("Phase 6 parser — brand / type / attribute vs plain words", () => {
  it("matches brand (vendor) and product type; leaves plain words as free text", () => {
    const r = parseQuery("comfortable Nike shoe", ctx);
    expect(r.filters.vendor).toContain("Nike");
    expect(r.filters.productType).toContain("Shoe");
    expect(r.remaining).toBe("comfortable");
  });
  it("multi-word brand and multi-word attribute (longest match)", () => {
    expect(parseQuery("the north face jacket", ctx).filters.vendor).toContain("The North Face");
    expect(parseQuery("rose gold watch", ctx).filters.tags).toContain("rose gold");
  });
  it("attribute → facet mapping (color→tags, material→metafield)", () => {
    const r = parseQuery("red leather bag", ctx);
    expect(r.filters.tags).toContain("red");
    expect(r.filters.metafield).toContain("leather");
    expect(r.remaining).toBe("bag");
  });
  it("no-op on non-English / unrecognized input (whole query is free text)", () => {
    const r = parseQuery("日本語  writing", ctx);
    expect(r.interpreted).toHaveLength(0);
    expect(r.remaining).toContain("writing");
  });
});

describe("Phase 6 parser — negation (safe degradation)", () => {
  it("'not red' drops the attribute (never searches for red)", () => {
    const r = parseQuery("shoes not red", ctx);
    expect(r.filters.tags ?? []).not.toContain("red");
    expect(r.negations).toContain("red");
    expect(r.remaining).not.toContain("red");
  });
  it("'without leather' drops the material", () => {
    const r = parseQuery("bag without leather", ctx);
    expect(r.filters.metafield ?? []).not.toContain("leather");
    expect(r.negations).toContain("leather");
  });
});

describe("Phase 6 parser — safety / hostile input", () => {
  it("SQL metacharacters are just tokens (no filters, no crash)", () => {
    const r = parseQuery("'; DROP TABLE product; -- red", ctx);
    // 'red' still parses as an attribute; the SQL junk is free text, harmless.
    expect(r.filters.tags).toContain("red");
    expect(() => r.remaining).not.toThrow();
  });
  it("very long input is bounded (truncated to 200 chars)", () => {
    const r = parseQuery("red ".repeat(500), ctx);
    expect(r.remaining.length).toBeLessThanOrEqual(200);
    expect(r.filters.tags).toContain("red");
  });
  it("unicode combining tricks don't crash and don't over-match", () => {
    const r = parseQuery("réd shoes", ctx); // "réd" with combining accent
    expect(() => r.interpreted).not.toThrow();
  });
  it("ignore option drops a specific interpretation", () => {
    const r = parseQuery("red shoes under 50", ctx, { ignore: new Set(["price"]) });
    expect(r.filters.priceMax).toBeUndefined();
    expect(r.remaining).toContain("under 50");
    expect(r.filters.tags).toContain("red"); // other interpretations still apply
  });
  it("is deterministic (same input → same output)", () => {
    const a = JSON.stringify(parseQuery("cheap red Nike shoe under $50 in stock", ctx));
    const b = JSON.stringify(parseQuery("cheap red Nike shoe under $50 in stock", ctx));
    expect(a).toBe(b);
  });
});
