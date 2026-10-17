import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkParity } from "../scripts/check-locale-parity.mjs";

/*
 * Phase 12.8 — storefront extension static checks for the new blocks
 * (back-in-stock notify, countdown, pre-order). DOM behaviour on a live theme
 * is Requires Verification; these assert the invariants we CAN check statically:
 * textContent-only rendering (never innerHTML), the consent box is unchecked by
 * default, locale parity (incl. the new keys), schema-default-aware forms, and
 * that each block loads core + its JS and targets the right proxy endpoint.
 */
const EXT = join(__dirname, "..", "extensions", "search-discovery-theme");
const block = (name: string) => readFileSync(join(EXT, "blocks", name), "utf8");
const asset = (name: string) => readFileSync(join(EXT, "assets", name), "utf8");

const NEW_BLOCKS = ["boost-notify.liquid", "boost-countdown.liquid", "boost-preorder.liquid"];
const NEW_ASSETS = ["boost-notify.js", "boost-countdown.js", "boost-preorder.js"];

describe("Phase 12 — new blocks + assets exist and are wired", () => {
  it("each new block + asset file exists", () => {
    for (const b of NEW_BLOCKS) expect(existsSync(join(EXT, "blocks", b)), b).toBe(true);
    for (const a of NEW_ASSETS) expect(existsSync(join(EXT, "assets", a)), a).toBe(true);
  });
  it("each new block loads boost-core.js and its own JS, defaulting proxy apps/search", () => {
    const pairs: Array<[string, string]> = [
      ["boost-notify.liquid", "boost-notify.js"],
      ["boost-countdown.liquid", "boost-countdown.js"],
      ["boost-preorder.liquid", "boost-preorder.js"],
    ];
    for (const [b, js] of pairs) {
      const src = block(b);
      expect(src.includes("boost-core.js"), b).toBe(true);
      expect(src.includes(js), b).toBe(true);
      expect(/default:\s*'apps'/.test(src), b + " prefix").toBe(true);
      expect(/default:\s*'search'/.test(src), b + " subpath").toBe(true);
    }
  });
  it("blocks target the correct proxy endpoints", () => {
    expect(asset("boost-notify.js")).toMatch(/\/back-in-stock/);
    expect(asset("boost-countdown.js")).toMatch(/\/countdown/);
    expect(asset("boost-preorder.js")).toMatch(/\/preorder/);
  });
});

describe("Phase 12 — textContent-only (never innerHTML)", () => {
  const ASSIGN = /\.innerHTML\s*=|\binsertAdjacentHTML\b|\bouterHTML\s*=/;
  it("none of the new JS files assign innerHTML/outerHTML/insertAdjacentHTML", () => {
    for (const a of NEW_ASSETS) expect(ASSIGN.test(asset(a)), a).toBe(false);
  });
  it("the card renderers (with the additive pre-order badge) still never assign innerHTML", () => {
    for (const a of ["boost-results.js", "boost-recommendations.js", "boost-bundle.js"]) {
      expect(ASSIGN.test(asset(a)), a).toBe(false);
      expect(asset(a).includes("preorder"), a + " renders the badge").toBe(true);
    }
  });
});

describe("Phase 12.2 — consent box is explicit + unchecked by default", () => {
  const src = block("boost-notify.liquid");
  it("renders a consent checkbox that is NOT pre-ticked", () => {
    expect(src).toMatch(/data-boost-notify-consent/);
    expect(src).toMatch(/type="checkbox"/);
    // the consent input must not carry a `checked` attribute (never pre-ticked)
    const consentLine = src.split("\n").find((l) => l.includes("data-boost-notify-consent")) || "";
    expect(/\bchecked\b/.test(consentLine)).toBe(false);
    // consent label text comes from locales (not hard-coded)
    expect(src).toMatch(/'boost\.notify\.consent' \| t/);
  });
  it("the notify JS requires consent + a valid email before sending", () => {
    const js = asset("boost-notify.js");
    expect(js).toMatch(/consentEl\.checked/);
    expect(js).toMatch(/EMAIL_RE/);
    expect(js).toMatch(/needConsent/);
  });
  it("the notify JS shows the form only when the item is unavailable", () => {
    expect(asset("boost-notify.js")).toMatch(/isUnavailable/);
  });
});

describe("Phase 12.5 — countdown: skew correction, reduced motion, coarse aria", () => {
  const js = asset("boost-countdown.js");
  it("uses the server-provided serverNow for skew correction", () => {
    expect(js).toMatch(/serverNow/);
    expect(js).toMatch(/skew/);
  });
  it("respects prefers-reduced-motion and announces coarsely (not per-second)", () => {
    expect(js).toMatch(/prefers-reduced-motion/);
    expect(js).toMatch(/fmtCoarse/);
  });
  it("the ticking clock is aria-hidden in the block markup", () => {
    expect(block("boost-countdown.liquid")).toMatch(/data-boost-countdown-clock[^>]*aria-hidden="true"/);
  });
});

describe("Phase 12 — locale parity (incl. new notify/countdown/preorder keys)", () => {
  it("storefront + schema locales stay at key parity", () => {
    const { ok, problems } = checkParity(join(EXT, "locales"));
    if (!ok) console.error(JSON.stringify(problems));
    expect(ok).toBe(true);
  });
  it("the new string keys are present in en + fr", () => {
    for (const f of ["en.default.json", "fr.json"]) {
      const j = JSON.parse(readFileSync(join(EXT, "locales", f), "utf8"));
      expect(j.boost.notify.consent, f).toBeTruthy();
      expect(j.boost.countdown.ends_in, f).toBeTruthy();
      expect(j.boost.preorder.badge, f).toBeTruthy();
    }
  });
});
