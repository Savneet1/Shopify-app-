import { describe, it, expect } from "vitest";
import { validateCountry, validateCurrency, validateLocale, validateHints } from "~/lib/search/hints";

/*
 * Phase 13.3 — market/context hint validation (UNTRUSTED input). Hostile cases:
 * nothing may pass that is not a strict, bounded, canonical value; everything
 * else → null (the default/byte-identical path). Never throws.
 */

describe("validateCountry (ISO 3166-1 alpha-2)", () => {
  it("accepts and upper-cases 2-letter codes", () => {
    expect(validateCountry("us")).toBe("US");
    expect(validateCountry("GB")).toBe("GB");
    expect(validateCountry(" ca ")).toBe("CA");
  });
  it("rejects anything else", () => {
    for (const v of ["USA", "u", "1", "u1", "", "  ", "us; DROP", "u\u0000s", 42, null, undefined, {}, ["US"]]) {
      expect(validateCountry(v as unknown)).toBeNull();
    }
  });
});

describe("validateCurrency (ISO 4217)", () => {
  it("accepts and upper-cases 3-letter codes", () => {
    expect(validateCurrency("usd")).toBe("USD");
    expect(validateCurrency("EUR")).toBe("EUR");
  });
  it("rejects anything else", () => {
    for (const v of ["US", "USDX", "12", "e\u0000ur", "", "US$", 3.5, null, {}]) {
      expect(validateCurrency(v as unknown)).toBeNull();
    }
  });
});

describe("validateLocale (BCP-47 subset, ≤10 chars)", () => {
  it("accepts language, language-REGION, language-Script, language-Script-REGION", () => {
    expect(validateLocale("en")).toBe("en");
    expect(validateLocale("EN")).toBe("en");
    expect(validateLocale("pt-br")).toBe("pt-BR");
    expect(validateLocale("zh-hant")).toBe("zh-Hant");
    expect(validateLocale("zh-Hant-HK")).toBe("zh-Hant-HK");
    expect(validateLocale("es-419")).toBe("es-419"); // UN M.49 region
  });
  it("rejects over-long, malformed, injection and non-strings", () => {
    for (const v of [
      "e", "english", "en_US", "en-USA", "en-", "-en", "en--US",
      "toooolong-XX", "en\u0000", "<script>", "en;DROP", 1, null, undefined, {}, ["en"],
      "abcdefghijk", // 11 chars > cap
    ]) {
      expect(validateLocale(v as unknown)).toBeNull();
    }
  });
});

describe("validateHints bag", () => {
  it("validates each field independently and drops unknowns", () => {
    expect(validateHints({ country: "us", currency: "eur", locale: "pt-br", evil: "x" }))
      .toEqual({ country: "US", currency: "EUR", locale: "pt-BR" });
  });
  it("junk bag → all null (default path)", () => {
    expect(validateHints("not an object" as unknown)).toEqual({ country: null, currency: null, locale: null });
    expect(validateHints(null)).toEqual({ country: null, currency: null, locale: null });
    expect(validateHints({ country: "USA", currency: 5, locale: "en_US" }))
      .toEqual({ country: null, currency: null, locale: null });
  });
});
