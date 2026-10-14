import { describe, it, expect } from "vitest";
import {
  redactPII, cleanQuery, validateEvent, validateBatch, MAX_BATCH, EVENT_TYPES, SURFACES,
} from "~/lib/analytics/events";
import { twoProportionZ, compareArms, variantStats, MIN_TRIALS_PER_ARM, Z_SIGNIFICANT } from "~/lib/analytics/abtest";
import { attributeAddToCarts, type SessionEvent } from "~/lib/analytics/attribution";
import { csvCell, csvRow, buildCsv } from "~/lib/analytics/csv";
import { mapCustomerEvent, mapCustomerEvents } from "~/lib/analytics/customer-events";

/* Phase 11.8 — pure unit tests. No DB. */

describe("Phase 11 — PII redaction", () => {
  it("redacts emails, phones, cards, URLs, long tokens", () => {
    expect(redactPII("contact me at john.doe@example.com now").text).toBe("contact me at [redacted] now");
    expect(redactPII("call 415 555 1234 please").redacted).toBe(true);
    expect(redactPII("card 4111 1111 1111 1111").text).toContain("[redacted]");
    expect(redactPII("see https://evil.example.com/x?y=1").text).toContain("[redacted]");
    expect(redactPII("token ABCDEF0123456789GHIJKL").text).toContain("[redacted]");
  });
  it("leaves ordinary queries untouched", () => {
    const r = redactPII("red running shoes size 10");
    expect(r.redacted).toBe(false);
    expect(r.text).toBe("red running shoes size 10");
  });
  it("cleanQuery normalizes, bounds length, and flags redaction", () => {
    const r = cleanQuery("  Red   SHOES  ");
    expect(r.queryNorm).toBe("red shoes");
    expect(r.redacted).toBe(false);
    const long = cleanQuery("x".repeat(500));
    expect((long.queryNorm ?? "").length).toBeLessThanOrEqual(100);
    const pii = cleanQuery("email a@b.com");
    expect(pii.redacted).toBe(true);
    expect(cleanQuery(null).queryNorm).toBeNull();
    expect(cleanQuery("   ").queryNorm).toBeNull();
  });
  it("a phone number does not survive even split by the length bound", () => {
    expect(cleanQuery("my number is 9876543210").queryNorm).not.toMatch(/\d{7,}/);
  });
});

describe("Phase 11 — event validation (hostile input never throws)", () => {
  const ok = { eventType: "result_click", surface: "search_page", productGid: "gid://shopify/Product/123", position: 2 };
  it("accepts a well-formed event and strips session when not allowed", () => {
    const e = validateEvent({ ...ok, sessionId: "abc_DEF-123" }, { sessionAllowed: false })!;
    expect(e.eventType).toBe("result_click");
    expect(e.sessionId).toBeNull();
    const e2 = validateEvent({ ...ok, sessionId: "abc_DEF-123" }, { sessionAllowed: true })!;
    expect(e2.sessionId).toBe("abc_DEF-123");
  });
  it("drops unknown keys, bad enums, malformed gid/uuid/session, out-of-range ints", () => {
    expect(validateEvent({ ...ok, bogusKey: 1 }, { sessionAllowed: true })).toBeNull();
    expect(validateEvent({ eventType: "nope", surface: "search_page" }, { sessionAllowed: true })).toBeNull();
    expect(validateEvent({ eventType: "result_click", surface: "moon" }, { sessionAllowed: true })).toBeNull();
    expect(validateEvent({ ...ok, productGid: "gid://shopify/Variant/1" }, { sessionAllowed: true })).toBeNull();
    expect(validateEvent({ ...ok, sessionId: "bad session!" }, { sessionAllowed: true })).toBeNull();
    expect(validateEvent({ ...ok, position: -1 }, { sessionAllowed: true })).toBeNull();
    expect(validateEvent({ ...ok, position: 10 ** 9 }, { sessionAllowed: true })).toBeNull();
    expect(validateEvent({ ...ok, experimentId: "not-a-uuid" }, { sessionAllowed: true })).toBeNull();
    expect(validateEvent({ ...ok, variant: "C" }, { sessionAllowed: true })).toBeNull();
    expect(validateEvent("not an object", { sessionAllowed: true })).toBeNull();
    expect(validateEvent(null, { sessionAllowed: true })).toBeNull();
    expect(validateEvent({ ...ok, properties: { nested: { a: 1 } } }, { sessionAllowed: true })!.properties).toEqual({});
  });
  it("ignores a client ts field (server stamps occurred_at)", () => {
    const e = validateEvent({ ...ok, ts: 1700000000000 }, { sessionAllowed: true });
    expect(e).not.toBeNull();
    expect((e as any).ts).toBeUndefined();
    expect((e as any).occurredAt).toBeUndefined();
  });
  it("batch caps at MAX_BATCH and counts rejects (valid survive alongside invalid)", () => {
    const raw = [ok, { eventType: "bad" }, { ...ok, sessionId: "ok1" }];
    const { clean, rejected } = validateBatch(raw, { sessionAllowed: true });
    expect(clean.length).toBe(2);
    expect(rejected).toBe(1);
    const over = Array.from({ length: MAX_BATCH + 5 }, () => ok);
    const r2 = validateBatch(over, { sessionAllowed: true });
    expect(r2.clean.length).toBe(MAX_BATCH);
    expect(r2.rejected).toBe(5);
    expect(validateBatch("not an array", { sessionAllowed: true })).toEqual({ clean: [], rejected: 0 });
  });
  it("enum lists are the documented closed sets", () => {
    expect(EVENT_TYPES.length).toBe(10);
    expect(SURFACES.length).toBe(5);
  });
});

describe("Phase 11 — A/B z-test", () => {
  it("known z: equal-size arms, pooled", () => {
    // n=1000 each, p1=0.12, p2=0.10, pooled=0.11 → z ≈ 1.429
    const z = twoProportionZ({ successes: 120, trials: 1000 }, { successes: 100, trials: 1000 })!;
    expect(z).toBeCloseTo(1.429, 2);
  });
  it("zero denominators return null", () => {
    expect(twoProportionZ({ successes: 0, trials: 0 }, { successes: 1, trials: 10 })).toBeNull();
    expect(twoProportionZ({ successes: 0, trials: 0 }, { successes: 0, trials: 0 })).toBeNull();
  });
  it("all-success/all-failure both arms → null (denominator 0)", () => {
    expect(twoProportionZ({ successes: 100, trials: 100 }, { successes: 200, trials: 200 })).toBeNull();
  });
  it("below sample thresholds → inconclusive (no z)", () => {
    const c = compareArms({ successes: 5, trials: 50 }, { successes: 60, trials: 600 });
    expect(c.verdict).toBe("inconclusive_sample");
    expect(c.z).toBeNull();
    expect(c.note).toMatch(/not enough data/);
  });
  it("above thresholds → significant / not_significant by |z| >= 1.96", () => {
    const big = compareArms({ successes: 300, trials: 1000 }, { successes: 150, trials: 1000 });
    expect(big.verdict).toBe("significant");
    expect(Math.abs(big.z!)).toBeGreaterThanOrEqual(Z_SIGNIFICANT);
    const small = compareArms({ successes: 210, trials: 1000 }, { successes: 200, trials: 1000 });
    expect(small.verdict).toBe("not_significant");
    expect(MIN_TRIALS_PER_ARM).toBe(100);
  });
  it("variantStats computes rates with a zero-search guard", () => {
    expect(variantStats("A", 100, 20, 5)).toMatchObject({ ctr: 0.2, addToCartRate: 0.05 });
    expect(variantStats("B", 0, 0, 0).ctr).toBe(0);
  });
});

describe("Phase 11 — attribution (last-click, session window)", () => {
  const base = (over: Partial<SessionEvent>): SessionEvent => ({
    sessionId: "s1", eventType: "result_click", occurredAt: new Date("2026-05-01T10:00:00Z"),
    queryNorm: "shoes", productGid: "gid://shopify/Product/1", ...over,
  });
  it("links the most recent click of the same product within the window", () => {
    const evs = [
      base({ eventType: "result_click", occurredAt: new Date("2026-05-01T10:00:00Z") }),
      base({ eventType: "add_to_cart_from_search", occurredAt: new Date("2026-05-01T10:05:00Z") }),
    ];
    const out = attributeAddToCarts(evs, 30);
    expect(out.length).toBe(1);
    expect(out[0].productGid).toBe("gid://shopify/Product/1");
    expect(out[0].query).toBe("shoes");
  });
  it("does not link across the inactivity window", () => {
    const evs = [
      base({ eventType: "result_click", occurredAt: new Date("2026-05-01T10:00:00Z") }),
      base({ eventType: "add_to_cart_from_search", occurredAt: new Date("2026-05-01T11:00:00Z") }),
    ];
    expect(attributeAddToCarts(evs, 30).length).toBe(0);
  });
  it("ignores session-less events and different products; order-independent", () => {
    const evs = [
      base({ sessionId: null, eventType: "add_to_cart_from_search" }),
      base({ eventType: "add_to_cart_from_search", occurredAt: new Date("2026-05-01T10:05:00Z"), productGid: "gid://shopify/Product/2" }),
      base({ eventType: "result_click", occurredAt: new Date("2026-05-01T10:00:00Z"), productGid: "gid://shopify/Product/1" }),
    ];
    expect(attributeAddToCarts(evs, 30).length).toBe(0); // no click for p2, p1 has no ATC
  });
});

describe("Phase 11 — CSV escaping / formula injection", () => {
  it("neutralizes cells starting with = + - @ tab CR", () => {
    expect(csvCell("=1+2")).toBe("'=1+2");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@ref")).toBe("'@ref");
    expect(csvCell("\tx")).toBe("'\tx"); // tab is not an RFC-quote char
    // a leading CR is BOTH neutralized (') AND RFC-quoted (CR is a quote char)
    expect(csvCell("\rx")).toBe('"\'\rx"');
  });
  it("escapes quotes/commas/newlines per RFC 4180", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("hostile query text stays inert and quoted", () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
    expect(csvRow(["=1", "ok"])).toBe("'=1,ok");
    const csv = buildCsv(["q"], [["=cmd|' /C calc"]], 10);
    expect(csv.split("\r\n")[1].startsWith("'=cmd")).toBe(true);
  });
  it("buildCsv caps rows", () => {
    const rows = Array.from({ length: 5 }, (_, i) => [i]);
    expect(buildCsv(["n"], rows, 2).trim().split("\r\n").length).toBe(3); // header + 2
  });
});

describe("Phase 11 — unwired customer-events mapping", () => {
  it("maps search_submitted and product_added_to_cart; checkout_completed → null", () => {
    expect(mapCustomerEvent({ name: "search_submitted", data: { query: "hats" } })).toMatchObject({ eventType: "search_performed", query: "hats" });
    expect(mapCustomerEvent({ name: "product_added_to_cart", data: { cartLine: { merchandise: { product: { id: "gid://shopify/Product/9" } } } } }))
      .toMatchObject({ eventType: "add_to_cart_from_search", productGid: "gid://shopify/Product/9" });
    expect(mapCustomerEvent({ name: "checkout_completed", data: {} })).toBeNull();
    expect(mapCustomerEvent({ name: "unknown" })).toBeNull();
  });
  it("drops a malformed product id rather than passing it through", () => {
    const m = mapCustomerEvent({ name: "product_added_to_cart", data: { cartLine: { merchandise: { product: { id: "12345" } } } } })!;
    expect(m.productGid).toBeUndefined();
  });
  it("mapCustomerEvents filters unmappable", () => {
    const out = mapCustomerEvents([{ name: "search_submitted", data: { query: "a" } }, { name: "checkout_completed" }]);
    expect(out.length).toBe(1);
  });
});
