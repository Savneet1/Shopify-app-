import { describe, expect, it } from "vitest";
import { damerauLevenshtein, distanceWithin } from "~/lib/search/damerau";
import { maxFuzzyDistance, andLex, prefixLex, orLex, fuzzyLex } from "~/lib/search/rewrite";
import { validateDestination, RedirectValidationError } from "~/lib/search/redirects";
import { expandQuery, type SynonymRow } from "~/lib/search/synonyms";
import { applyStopwords, DEFAULT_STOPWORDS } from "~/lib/search/stopwords";
import { isFuzzable, isNumericToken, isCodeLikeToken, normalizeQuery, tokenize } from "~/lib/search/text";

describe("Phase 5 units — Damerau-Levenshtein", () => {
  it("counts an adjacent transposition as ONE edit", () => {
    expect(damerauLevenshtein("teh", "the")).toBe(1);
    expect(damerauLevenshtein("recieve", "receive")).toBe(1);
    expect(damerauLevenshtein("ashley", "ahsley")).toBe(1);
  });
  it("classic single edits", () => {
    expect(damerauLevenshtein("cat", "cat")).toBe(0);
    expect(damerauLevenshtein("cat", "cats")).toBe(1); // insert
    expect(damerauLevenshtein("cats", "cat")).toBe(1); // delete
    expect(damerauLevenshtein("cat", "cot")).toBe(1); // substitute
    expect(damerauLevenshtein("kitten", "sitting")).toBe(3);
  });
  it("distanceWithin caps by length gap", () => {
    expect(distanceWithin("shoe", "shoelace", 2)).toBe(3); // len gap 4 > 2 -> max+1
    expect(distanceWithin("shoez", "shoes", 1)).toBe(1);
  });
});

describe("Phase 5 units — distance thresholds by length", () => {
  it("1-3 chars: no fuzzy; 4-7: distance 1; 8+: distance 2", () => {
    expect(maxFuzzyDistance(1)).toBe(0);
    expect(maxFuzzyDistance(3)).toBe(0);
    expect(maxFuzzyDistance(4)).toBe(1);
    expect(maxFuzzyDistance(7)).toBe(1);
    expect(maxFuzzyDistance(8)).toBe(2);
    expect(maxFuzzyDistance(12)).toBe(2);
  });
});

describe("Phase 5 units — token classification", () => {
  it("numeric and code-like tokens are not fuzzable", () => {
    expect(isNumericToken("2024")).toBe(true);
    expect(isCodeLikeToken("abc123")).toBe(true);
    expect(isFuzzable("2024")).toBe(false);
    expect(isFuzzable("abc123")).toBe(false);
    expect(isFuzzable("shoes")).toBe(true);
  });
  it("normalizeQuery folds case/punctuation/whitespace", () => {
    expect(normalizeQuery("  Red,  SHOES!! ")).toBe("red shoes");
    expect(tokenize("Red-Shoes 42")).toEqual(["red", "shoes", "42"]);
  });
});

describe("Phase 5 units — lexeme builders", () => {
  it("build tsquery-safe lex strings", () => {
    expect(andLex(["a", "b"])).toBe("a & b");
    expect(prefixLex(["a", "b"])).toBe("a & b:*");
    expect(orLex(["a", "b"])).toBe("a | b");
    expect(fuzzyLex([{ token: "a", candidates: ["a1", "a2"] }, { token: "b", candidates: [] }])).toBe("(a | a1 | a2) & b");
    expect(fuzzyLex([{ token: "a", candidates: [] }])).toBeNull(); // no candidates -> null
  });
});

describe("Phase 5 units — synonym expansion", () => {
  const twoWay: SynonymRow = { id: "1", kind: "two_way", from_term: null, terms: ["sneakers", "trainers", "kicks"] };
  const oneWay: SynonymRow = { id: "2", kind: "one_way", from_term: "couch", terms: ["sofa"] };
  const multi: SynonymRow = { id: "3", kind: "two_way", from_term: null, terms: ["running shoes", "runners"] };

  it("two-way expands to the other terms", () => {
    const { expansions } = expandQuery(["sneakers"], [twoWay]);
    const set = expansions.map((e) => e.tokens.join(" "));
    expect(set).toContain("trainers");
    expect(set).toContain("kicks");
    expect(set).not.toContain("sneakers"); // original not re-emitted
  });
  it("one-way expands from -> to only (not reverse)", () => {
    expect(expandQuery(["couch"], [oneWay]).expansions.map((e) => e.tokens.join(" "))).toContain("sofa");
    expect(expandQuery(["sofa"], [oneWay]).expansions).toHaveLength(0); // not reverse
  });
  it("multi-word phrase synonym", () => {
    const { expansions } = expandQuery(["running", "shoes"], [multi]);
    expect(expansions.map((e) => e.tokens.join(" "))).toContain("runners");
  });
  it("expansion cap is enforced", () => {
    const many: SynonymRow = { id: "4", kind: "two_way", from_term: null, terms: ["x", ...Array.from({ length: 40 }, (_, i) => "y" + i)] };
    const { expansions, truncated } = expandQuery(["x"], [many]);
    expect(expansions.length).toBeLessThanOrEqual(20);
    expect(truncated).toBe(true);
  });
});

describe("Phase 5 units — stop words", () => {
  const stop = new Set(DEFAULT_STOPWORDS);
  it("drops stop words when a non-stop term remains", () => {
    const r = applyStopwords(["the", "red", "shoes"], stop);
    expect(r.kept).toEqual(["red", "shoes"]);
    expect(r.allStop).toBe(false);
  });
  it("a query of only stop words keeps them all", () => {
    const r = applyStopwords(["the", "and", "of"], stop);
    expect(r.kept).toEqual(["the", "and", "of"]);
    expect(r.allStop).toBe(true);
  });
});

describe("Phase 5 units — redirect destination validation (open-redirect protection)", () => {
  const shop = "acme.myshopify.com";
  it("accepts a same-shop relative path", () => {
    expect(validateDestination("/collections/sale", shop)).toBe("/collections/sale");
  });
  it("accepts an absolute https URL on the shop's own domain", () => {
    expect(validateDestination("https://acme.myshopify.com/pages/x", shop)).toBe("https://acme.myshopify.com/pages/x");
  });
  it("rejects external hosts", () => {
    expect(() => validateDestination("https://evil.com/x", shop)).toThrow(RedirectValidationError);
  });
  it("rejects javascript:/data:/file: schemes", () => {
    for (const d of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:x"]) {
      expect(() => validateDestination(d, shop)).toThrow(RedirectValidationError);
    }
  });
  it("rejects protocol-relative //host and /\\host", () => {
    expect(() => validateDestination("//evil.com", shop)).toThrow(RedirectValidationError);
    expect(() => validateDestination("/\\evil.com", shop)).toThrow(RedirectValidationError);
  });
  it("rejects control-character bypasses", () => {
    expect(() => validateDestination("java\nscript:alert(1)", shop)).toThrow(RedirectValidationError);
  });
});
