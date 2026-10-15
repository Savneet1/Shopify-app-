import { describe, it, expect } from "vitest";
import {
  redactPII, cleanQuery, redactValue, canonicalizeForPII,
  validateEvent, validateBatch, MAX_BATCH, EVENT_TYPES, SURFACES,
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

/*
 * Phase 11.1 N2 — redaction must not be evadable by splitting/obfuscating PII
 * with invisible/format characters and non-ASCII decimal digits. Each probe is
 * UNREDACTED by the raw-text-only approach but MUST be redacted now, because we
 * canonicalize (NFKC + strip invisibles + fold digits) BEFORE redacting and
 * redact a SECOND time after normalization.
 */
describe("Phase 11.1 — PII redaction is evasion-resistant (N2)", () => {
  // Invisible / format code points used to split a run.
  const ZWSP = "​";   // zero-width space
  const ZWNJ = "‌";   // zero-width non-joiner (Cf)
  const SHY = "­";    // soft hyphen
  const WJ = "⁠";     // word joiner
  const BOM = "﻿";    // zero-width no-break space
  // Full-width digits (NFKC-folded) and Arabic-Indic digits (explicitly folded).
  const fw = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCodePoint(0xff10 + (d.charCodeAt(0) - 48)));
  const arab = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCodePoint(0x0660 + (d.charCodeAt(0) - 48)));

  // The exact probe inputs for N2. Each should → "[redacted]" with redacted=true.
  const cardProbes: Array<[string, string]> = [
    ["zero-width-split card", `4111${ZWSP}1111${ZWSP}1111${ZWSP}1111`],
    ["soft-hyphen-split card", `4111${SHY}1111${SHY}1111${SHY}1111`],
    ["full-width card w/ separators", fw("4111") + " " + fw("1111") + " " + fw("1111") + " " + fw("1111")],
    ["full-width card contiguous", fw("4111111111111111")],
  ];
  const phoneProbes: Array<[string, string]> = [
    ["full-width phone", fw("4155551234")],
    ["zero-width-split phone", `415${ZWNJ}555${ZWNJ}1234`],
    ["arabic-indic phone", arab("4155551234")],
    ["word-joiner-split phone", `9876${WJ}543210`],
  ];
  const emailProbes: Array<[string, string]> = [
    ["full-width @ email", "john.doe" + "＠" + "example.com"],
    ["zero-width-in email", `john.doe@ex${ZWSP}ample.com`],
    ["IDN email", "josé@exämple.com"],
    ["BOM-wrapped email", `${BOM}john@example.com${BOM}`],
  ];

  for (const [label, input] of [...cardProbes, ...phoneProbes, ...emailProbes]) {
    it(`cleanQuery redacts: ${label}`, () => {
      const r = cleanQuery(input);
      expect(r.redacted).toBe(true);
      expect(r.queryNorm).toBe("[redacted]");
    });
  }

  it("the same obfuscations are redacted inside property string values", () => {
    for (const [, input] of [...cardProbes, ...phoneProbes, ...emailProbes]) {
      expect(redactValue(input)).toContain("[redacted]");
    }
  });

  it("canonicalizeForPII strips invisibles and folds digits to ASCII", () => {
    expect(canonicalizeForPII(`41${ZWSP}11`)).toBe("4111");
    expect(canonicalizeForPII(fw("2024"))).toBe("2024");
    expect(canonicalizeForPII(arab("2024"))).toBe("2024");
  });

  // False-positive guards: real product queries must stay UNREDACTED.
  const guards = [
    "iphone 15 pro max 256gb",
    "ps5 2024 slim",
    "size 10 shoes",
    "2 pack",
    "iphone 15",
  ];
  for (const q of guards) {
    it(`does not over-redact a real query: "${q}"`, () => {
      const r = cleanQuery(q);
      expect(r.redacted).toBe(false);
      expect(r.queryNorm).not.toContain("[redacted]");
    });
  }

  // Table test: a card and a phone across every separator × invisible combo.
  it("table: card/phone survive no separator/invisible combination", () => {
    const seps = ["", " ", "-", ZWSP, ZWNJ, SHY, WJ, BOM];
    for (const sep of seps) {
      const card = `4111${sep}1111${sep}1111${sep}1111`;
      const phone = `415${sep}555${sep}1234`;
      expect(cleanQuery(card).redacted).toBe(true);
      expect(cleanQuery(phone).redacted).toBe(true);
    }
  });

  it("redaction is idempotent and never throws on adversarial input", () => {
    const once = cleanQuery("card 4111 1111 1111 1111").queryNorm!;
    expect(cleanQuery(once).queryNorm).toBe(once);
    expect(() => cleanQuery("\u0000".repeat(50) + fw("4111111111111111"))).not.toThrow();
    expect(() => redactValue("x".repeat(9000))).not.toThrow();
  });

  it("DOCUMENTED non-detections: names/addresses and spelled-out emails are NOT caught", () => {
    // These are accepted limitations (documented in docs/PHASE11.md).
    expect(cleanQuery("john smith").redacted).toBe(false);
    expect(cleanQuery("123 main street").redacted).toBe(false);
    expect(cleanQuery("john at example dot com").redacted).toBe(false);
    // ...and a long bare digit run (8+) IS redacted — an accepted false positive
    // (e.g. a long SKU) we prefer over leaking a phone/account number.
    expect(cleanQuery("12345678").redacted).toBe(true);
  });
});

/*
 * Phase 11.1 N3 — CSV neutralization must look past LEADING WHITESPACE: a cell
 * whose first NON-whitespace char is = + - @ (or TAB/CR) is still neutralized,
 * because spreadsheet apps trim then evaluate.
 */
describe("Phase 11.1 — CSV neutralizes past leading whitespace (N3)", () => {
  it("neutralizes a formula hidden behind a leading space/tab/CR", () => {
    expect(csvCell(" =1+1")).toBe("'" + " =1+1");       // leading space
    expect(csvCell("  @x")).toBe("'" + "  @x");           // leading spaces
    expect(csvCell("\t=cmd")).toBe("'\t=cmd");             // leading TAB: neutralized; TAB is not an RFC-quote char
    expect(csvCell("\r=cmd")).toBe('"\'\r=cmd"');          // leading CR (CR is an RFC quote char)
  });
  it("leading-tab plain text (no formula lead) is neutralized because TAB itself is dangerous", () => {
    // "\tx": first non-ws char is 'x', but the leading char is a TAB, which the
    // prefix set still treats as dangerous — matches existing csvCell("\\tx").
    expect(csvCell("\tx")).toBe("'\tx");
  });
  it("still neutralizes the plain leading cases (unchanged behaviour)", () => {
    expect(csvCell("=1+2")).toBe("'=1+2");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@ref")).toBe("'@ref");
  });
  it("does NOT neutralize an ordinary value that merely contains = later", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("size: 10")).toBe("size: 10");
    expect(csvCell("  hello")).toBe("  hello");
  });
});
