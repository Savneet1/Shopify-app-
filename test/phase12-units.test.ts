import { describe, it, expect } from "vitest";
import {
  encryptSecret, decryptSecret, hasEncryptionKey, emailHash, generateToken,
  deriveUnsubToken, hashToken, verifyToken, EncryptionKeyMissingError, DecryptionError,
} from "~/lib/crypto/secret.server";
import { normalizeEmail, maskEmail } from "~/lib/restock/email";
import { escapeHtml, normalizeLocale, confirmEmail, restockEmail } from "~/lib/restock/templates";
import { safeHttpsUrl, unsubscribeUrl, confirmUrl, listUnsubscribeHeaders } from "~/lib/restock/notify";
import { windowOpen, countdownForTarget, type CountdownRule } from "~/lib/countdown/rules";
import { scheduleApplies, ruleMatchesProduct, preorderForProduct, type PreorderRule } from "~/lib/preorder/rules";

/* Phase 12.8 — pure unit tests. No DB. */

describe("Phase 12 — AES-256-GCM secret encryption", () => {
  it("round-trips a password", () => {
    const ct = encryptSecret("hunter2!");
    expect(ct).not.toContain("hunter2");           // never plaintext
    expect(decryptSecret(ct)).toBe("hunter2!");
    // non-deterministic IV → different ciphertext each time
    expect(encryptSecret("hunter2!")).not.toBe(ct);
  });
  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const ct = encryptSecret("secret");
    const raw = Buffer.from(ct, "base64"); raw[raw.length - 1] ^= 0xff;
    expect(() => decryptSecret(raw.toString("base64"))).toThrow(DecryptionError);
    expect(() => decryptSecret("not-base64-@@@")).toThrow(DecryptionError);
    expect(() => decryptSecret("")).toThrow(DecryptionError);
  });
  it("refuses to encrypt when the key is absent (never stores plaintext)", () => {
    const saved = process.env.EMAIL_ENCRYPTION_KEY;
    try {
      delete process.env.EMAIL_ENCRYPTION_KEY;
      expect(hasEncryptionKey()).toBe(false);
      expect(() => encryptSecret("x")).toThrow(EncryptionKeyMissingError);
    } finally { process.env.EMAIL_ENCRYPTION_KEY = saved; }
    expect(hasEncryptionKey()).toBe(true);
  });
});

describe("Phase 12 — keyed email hash + tokens", () => {
  it("emailHash is deterministic and shop-scoped", () => {
    const a = emailHash("shop-1", "a@b.com");
    expect(a).toBe(emailHash("shop-1", "a@b.com"));       // deterministic
    expect(a).not.toBe(emailHash("shop-2", "a@b.com"));   // shop-scoped
    expect(/^[0-9a-f]{64}$/.test(a)).toBe(true);
  });
  it("generateToken is unguessable + url-safe; hashToken/verifyToken round-trip", () => {
    const t = generateToken();
    expect(/^[A-Za-z0-9_-]{32,}$/.test(t)).toBe(true);
    const h = hashToken(t);
    expect(verifyToken(t, h)).toBe(true);
    expect(verifyToken(t + "x", h)).toBe(false);
    expect(verifyToken("", h)).toBe(false);
    expect(verifyToken(t, null)).toBe(false);
  });
  it("deriveUnsubToken is deterministic per (shop, subscription) and unguessable", () => {
    const t = deriveUnsubToken("shop-1", "sub-1");
    expect(t).toBe(deriveUnsubToken("shop-1", "sub-1"));
    expect(t).not.toBe(deriveUnsubToken("shop-1", "sub-2"));
    expect(t).not.toBe(deriveUnsubToken("shop-2", "sub-1"));
    expect(verifyToken(t, hashToken(t))).toBe(true);
  });
});

describe("Phase 12 — email normalisation, validation, masking", () => {
  it("lowercases + trims; folds unicode/full-width; rejects CR/LF/NUL and junk", () => {
    expect(normalizeEmail("  John.Doe@Example.COM ")).toEqual({ email: "john.doe@example.com", valid: true });
    // full-width @ and full-width letters normalise to ASCII (canonicalizeForPII)
    expect(normalizeEmail("ＪＯＨＮ＠ＥＸＡＭＰＬＥ.ＣＯＭ").email).toBe("john@example.com");
    expect(normalizeEmail("a@b.com\r\nBcc: x@y.com")).toEqual({ email: null, valid: false });
    expect(normalizeEmail("a@b.com\u0000")).toEqual({ email: null, valid: false });
    expect(normalizeEmail("not-an-email")).toEqual({ email: null, valid: false });
    expect(normalizeEmail("a@b")).toEqual({ email: null, valid: false });
    expect(normalizeEmail("x".repeat(400) + "@b.com")).toEqual({ email: null, valid: false });
    expect(normalizeEmail(null)).toEqual({ email: null, valid: false });
    expect(normalizeEmail("Name <a@b.com>")).toEqual({ email: null, valid: false }); // no display-name
  });
  it("masks for admin display / logs", () => {
    expect(maskEmail("john.doe@example.com")).toBe("j***@e***.com");
    expect(maskEmail("a@b.io")).toBe("a***@b***.io");
    expect(maskEmail("")).toBe("");
    expect(maskEmail("garbage")).toBe("***");
  });
});

describe("Phase 12 — email templates (en + fr, escaped)", () => {
  it("normalizeLocale maps to en/fr only", () => {
    expect(normalizeLocale("fr-CA")).toBe("fr");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale(null)).toBe("en");
    expect(normalizeLocale("de")).toBe("en");
  });
  it("escapeHtml neutralises markup", () => {
    expect(escapeHtml(`<b>"x"&'y'`)).toBe("&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;");
  });
  it("confirm + restock bodies include CTA, product, unsubscribe; html is escaped", () => {
    const c = confirmEmail("en", { shopName: "Shop", productTitle: "<Widget>", confirmUrl: "https://a/c", unsubscribeUrl: "https://a/u" });
    expect(c.subject).toMatch(/Widget/);
    expect(c.text).toMatch(/https:\/\/a\/c/);
    expect(c.html).toContain("&lt;Widget&gt;");          // escaped in html
    expect(c.html).toMatch(/https:\/\/a\/u/);
    const r = restockEmail("fr", { shopName: "Boutique", productTitle: "Sac", productUrl: "https://a/p", unsubscribeUrl: "https://a/u" });
    expect(r.subject).toMatch(/Sac/);
    expect(r.text).toMatch(/Boutique/);
  });
  it("safeHttpsUrl only passes absolute https; rejects http/userinfo/garbage", () => {
    expect(safeHttpsUrl("https://shop.example.com/p/1")).toBe("https://shop.example.com/p/1");
    expect(safeHttpsUrl("http://shop.example.com/p")).toBeNull();
    expect(safeHttpsUrl("https://user:pw@evil.com")).toBeNull();
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
  });
  it("unsubscribe/confirm urls carry sid + token; one-click header present", () => {
    const parts = { appUrl: "https://app.example.com/", shopDomain: "s.myshopify.com", shopId: "shop-1" };
    const u = unsubscribeUrl(parts, "sub-1");
    expect(u).toMatch(/^https:\/\/app\.example\.com\/restock\/unsubscribe\?s=sub-1&sid=shop-1&t=/);
    const c = confirmUrl(parts, "sub-1", "rawtok");
    expect(c).toMatch(/\/restock\/confirm\?s=sub-1&sid=shop-1&t=rawtok$/);
    expect(listUnsubscribeHeaders(u)).toEqual({
      "List-Unsubscribe": `<${u}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});

describe("Phase 12.5 — countdown math (injected clock, skew)", () => {
  const rule = (over: Partial<CountdownRule>): CountdownRule => ({
    id: "c1", scope: "global", matchValue: null, label: "Sale ends", endsAt: "2026-06-01T00:00:00Z",
    startsAt: null, expiredMessage: "Over", enabled: true, ...over,
  });
  const target = { gid: "gid://shopify/Product/1", handle: "x", collectionGids: [] };
  it("hidden before the start window; shown once open", () => {
    const r = rule({ startsAt: "2026-05-01T00:00:00Z" });
    expect(windowOpen(r, new Date("2026-04-30T23:59:59Z"))).toBe(false);
    expect(windowOpen(r, new Date("2026-05-01T00:00:00Z"))).toBe(true);
    expect(windowOpen(rule({ enabled: false }), new Date("2026-05-15T00:00:00Z"))).toBe(false);
  });
  it("payload carries endsAt + serverNow (skew) + expired flag", () => {
    const now = new Date("2026-05-20T12:00:00Z");
    const p = countdownForTarget([rule({})], target, now)!;
    expect(p.endsAt).toBe("2026-06-01T00:00:00Z");
    expect(p.serverNow).toBe(now.toISOString());
    expect(p.expired).toBe(false);
    const after = countdownForTarget([rule({})], target, new Date("2026-06-02T00:00:00Z"))!;
    expect(after.expired).toBe(true);
  });
  it("most specific scope wins (product > collection > global), then soonest end", () => {
    const rules = [
      rule({ id: "g", scope: "global", endsAt: "2026-06-10T00:00:00Z" }),
      rule({ id: "p", scope: "product", matchValue: "gid://shopify/Product/1", endsAt: "2026-06-20T00:00:00Z" }),
    ];
    const p = countdownForTarget(rules, target, new Date("2026-05-01T00:00:00Z"))!;
    expect(p.endsAt).toBe("2026-06-20T00:00:00Z"); // product rule chosen
    expect(countdownForTarget([rule({ scope: "product", matchValue: "gid://shopify/Product/999" })], target, new Date("2026-05-01T00:00:00Z"))).toBeNull();
  });
});

describe("Phase 12.4 — pre-order schedule boundaries + matching", () => {
  const rule = (over: Partial<PreorderRule>): PreorderRule => ({
    id: "r1", matchType: "tag", matchValue: "preorder", message: "Ships soon", releaseAt: null,
    startsAt: null, endsAt: null, enabled: true, ...over,
  });
  it("schedule is start-inclusive, end-exclusive", () => {
    const r = rule({ startsAt: "2026-05-01T00:00:00Z", endsAt: "2026-06-01T00:00:00Z" });
    expect(scheduleApplies(r, new Date("2026-04-30T23:59:59Z"))).toBe(false);
    expect(scheduleApplies(r, new Date("2026-05-01T00:00:00Z"))).toBe(true);   // inclusive start
    expect(scheduleApplies(r, new Date("2026-05-31T23:59:59Z"))).toBe(true);
    expect(scheduleApplies(r, new Date("2026-06-01T00:00:00Z"))).toBe(false);  // exclusive end
  });
  it("matches by tag/handle/gid/collection (case-insensitive where appropriate)", () => {
    const p = { gid: "gid://shopify/Product/1", handle: "Cool-Thing", tags: ["New", "PreOrder"], collectionGids: ["gid://shopify/Collection/9"] };
    expect(ruleMatchesProduct(rule({ matchType: "tag", matchValue: "preorder" }), p)).toBe(true);
    expect(ruleMatchesProduct(rule({ matchType: "handle", matchValue: "cool-thing" }), p)).toBe(true);
    expect(ruleMatchesProduct(rule({ matchType: "gid", matchValue: "gid://shopify/Product/1" }), p)).toBe(true);
    expect(ruleMatchesProduct(rule({ matchType: "collection", matchValue: "gid://shopify/Collection/9" }), p)).toBe(true);
    expect(ruleMatchesProduct(rule({ matchType: "tag", matchValue: "nope" }), p)).toBe(false);
  });
  it("most specific rule wins (gid > handle > collection > tag)", () => {
    const p = { gid: "gid://shopify/Product/1", handle: "h", tags: ["preorder"], collectionGids: [] };
    const badge = preorderForProduct([
      rule({ id: "tag", matchType: "tag", matchValue: "preorder", message: "by tag" }),
      rule({ id: "gid", matchType: "gid", matchValue: "gid://shopify/Product/1", message: "by gid" }),
    ], p, new Date("2026-05-01T00:00:00Z"))!;
    expect(badge.message).toBe("by gid");
    // disabled / out-of-window → null
    expect(preorderForProduct([rule({ enabled: false })], p, new Date())).toBeNull();
  });
});
