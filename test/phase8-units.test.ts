import { describe, it, expect } from "vitest";
import { assignVariant, bucketOf, fnv1a32, sanitizeToken, isUuid } from "~/lib/merch/assign";
import { ruleScopeMatches } from "~/lib/merch/rules";
import { isSameSitePath, isAllowedBannerImage } from "~/lib/merch/banners";

/*
 * Phase 8 pure-logic tests (no DB): A/B assignment determinism + split accuracy,
 * scope matching, and banner validators.
 */

describe("Phase 8 — A/B assignment (deterministic, no PII)", () => {
  it("no token → control; same inputs → same variant", () => {
    expect(assignVariant("shop", "exp", "", 50)).toBe("control");
    expect(assignVariant("shop", "exp", null, 50)).toBe("control");
    const a = assignVariant("shop", "exp", "token-123", 50);
    const b = assignVariant("shop", "exp", "token-123", 50);
    expect(a).toBe(b);
    expect(["A", "B"]).toContain(a);
  });

  it("split 0 → always A; split 100 → always B", () => {
    for (let i = 0; i < 200; i++) {
      expect(assignVariant("s", "e", "tok" + i, 0)).toBe("A");
      expect(assignVariant("s", "e", "tok" + i, 100)).toBe("B");
    }
  });

  it("split ~30% is accurate over many tokens (±3pp)", () => {
    const N = 20000;
    let b = 0;
    for (let i = 0; i < N; i++) if (assignVariant("shop-x", "exp-y", "visitor-" + i, 30) === "B") b++;
    const pct = (b / N) * 100;
    expect(Math.abs(pct - 30)).toBeLessThan(3);
  });

  it("bucket is in [0,100) and fnv1a32 is stable", () => {
    expect(bucketOf("anything")).toBeGreaterThanOrEqual(0);
    expect(bucketOf("anything")).toBeLessThan(100);
    expect(fnv1a32("abc")).toBe(fnv1a32("abc"));
    expect(fnv1a32("abc")).not.toBe(fnv1a32("abd"));
  });

  it("different experiments bucket independently for the same token", () => {
    // Not guaranteed different, but the seed includes the experiment id so the
    // function is not a pure function of the token alone.
    const variants = new Set<string>();
    for (let e = 0; e < 50; e++) variants.add(assignVariant("shop", "exp-" + e, "same-token", 50));
    expect(variants.size).toBe(2); // both A and B appear across experiments
  });
});

describe("Phase 8.1 — token + uuid hardening (H2)", () => {
  it("sanitizeToken bounds length and charset, else null (→ control)", () => {
    expect(sanitizeToken("good_tok-123")).toBe("good_tok-123");
    expect(sanitizeToken("x".repeat(64))).toHaveLength(64);
    expect(sanitizeToken("x".repeat(65))).toBeNull(); // too long
    expect(sanitizeToken("")).toBeNull();
    expect(sanitizeToken("bad token!")).toBeNull(); // space + "!"
    expect(sanitizeToken("'; DROP TABLE x;--")).toBeNull();
    expect(sanitizeToken(null)).toBeNull();
    expect(sanitizeToken(undefined)).toBeNull();
    // a sanitized token still assigns deterministically
    const t = sanitizeToken("visitor-42")!;
    expect(assignVariant("s", "e", t, 50)).toBe(assignVariant("s", "e", t, 50));
  });
  it("isUuid accepts only uuid-shaped ids", () => {
    expect(isUuid("3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071")).toBe(true);
    for (const v of ["not-a-uuid", "", "'; DROP TABLE ab_exposure;--", "x".repeat(10000), 123 as any, null as any]) {
      expect(isUuid(v), String(v)).toBe(false);
    }
  });
});

describe("Phase 8 — rule scope matching (normalized, deterministic)", () => {
  const r = (scope_type: any, scope_value: string | null) => ({ scope_type, scope_value });
  it("global always matches", () => {
    expect(ruleScopeMatches(r("global", null), "anything", null)).toBe(true);
    expect(ruleScopeMatches(r("global", null), "", "gid://x")).toBe(true);
  });
  it("query_exact matches the normalized query only", () => {
    expect(ruleScopeMatches(r("query_exact", "Red Shoe"), "  red   shoe ", null)).toBe(true);
    expect(ruleScopeMatches(r("query_exact", "red"), "red shoe", null)).toBe(false);
  });
  it("query_contains matches a normalized substring", () => {
    expect(ruleScopeMatches(r("query_contains", "shoe"), "red shoe", null)).toBe(true);
    expect(ruleScopeMatches(r("query_contains", "boot"), "red shoe", null)).toBe(false);
    expect(ruleScopeMatches(r("query_contains", ""), "red shoe", null)).toBe(false); // empty never matches
  });
  it("collection matches the exact collection gid only", () => {
    expect(ruleScopeMatches(r("collection", "gid://shopify/Collection/1"), "x", "gid://shopify/Collection/1")).toBe(true);
    expect(ruleScopeMatches(r("collection", "gid://shopify/Collection/1"), "x", "gid://shopify/Collection/2")).toBe(false);
    expect(ruleScopeMatches(r("collection", "gid://shopify/Collection/1"), "x", null)).toBe(false);
  });
});

describe("Phase 8 — banner validators", () => {
  it("isSameSitePath accepts root-relative, rejects escapes/schemes", () => {
    expect(isSameSitePath("/collections/sale")).toBe(true);
    expect(isSameSitePath("/a?b=1#c")).toBe(true);
    for (const p of ["//evil.com", "/\\evil.com", "https://x", "javascript:x", "", "/%0a/x", "/javascript:x"]) {
      expect(isSameSitePath(p), p).toBe(false);
    }
  });
  it("isAllowedBannerImage: https cdn/shop host or same-site path", () => {
    expect(isAllowedBannerImage("https://cdn.shopify.com/s/files/1/x.jpg?v=1")).toBe(true);
    expect(isAllowedBannerImage("https://acme.myshopify.com/x.png")).toBe(true);
    expect(isAllowedBannerImage("/cdn/shop/x.jpg")).toBe(true);
    for (const u of ["http://cdn.shopify.com/x.jpg", "https://evil.com/x.jpg", "//cdn.shopify.com/x.jpg",
      "javascript:x", "https://good@evil.com/x", ""]) {
      expect(isAllowedBannerImage(u), u).toBe(false);
    }
  });
});
