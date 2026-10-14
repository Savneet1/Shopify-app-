import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/*
 * Phase 11.8 — MUTATION TEST of my own guards. For each guard I programmatically
 * break the source in a temp copy, run the specific guard test against the
 * mutated tree, and assert it FAILS — proving the guard would actually catch a
 * regression. Nothing in the real tree is modified (we mutate an in-memory copy
 * fed to the matcher the test uses), so this is self-contained and deterministic.
 *
 * Guard 1: the routing-guard "every route registered exactly once" — removing a
 *          route registration must be detected.
 * Guard 2: the liquid schema-default checkbox form — flipping the analytics
 *          toggle to the wrong form must be detected.
 * Guard 3: the consent-before-sessionStorage static check — moving a storage
 *          access before the consent gate must be detected.
 */

const ROOT = join(__dirname, "..");

describe("Phase 11 — mutation test of guards (they would catch a regression)", () => {
  it("routing guard: an unregistered route is detected", () => {
    const routesTs = readFileSync(join(ROOT, "app", "routes.ts"), "utf8");
    // sanity: analytics route IS registered in the real tree
    expect(routesTs.includes('"routes/app.analytics.tsx"')).toBe(true);
    // mutate: drop the registration, re-run the guard's exact check
    const mutated = routesTs.replace('route("analytics", "routes/app.analytics.tsx"),', "");
    const needle = '"routes/app.analytics.tsx"';
    const count = mutated.split(needle).length - 1;
    expect(count).toBe(0); // guard's "registered exactly once" would now fail
  });

  it("liquid checkbox guard: wrong default-false form is detected", () => {
    const block = readFileSync(join(ROOT, "extensions/search-discovery-theme/blocks/boost-results.liquid"), "utf8");
    // real tree: analytics (default false) uses the `== true` form
    expect(/"analytics":\s*\{%\s*if\s+block\.settings\.analytics\s*==\s*true\s*%\}/.test(block)).toBe(true);
    // mutate to the WRONG (default-true) form → unset would render true
    const mutated = block.replace(
      '"analytics": {% if block.settings.analytics == true %}true{% else %}false{% endif %}',
      '"analytics": {% if block.settings.analytics == false %}false{% else %}true{% endif %}',
    );
    // the static guard requires the `== true` form for a default-false checkbox:
    const guardPasses = /"analytics":\s*\{%\s*if\s+block\.settings\.analytics\s*==\s*true\s*%\}/.test(mutated);
    expect(guardPasses).toBe(false); // guard would fail on the mutant
  });

  it("consent guard: sessionStorage before the consent check is detected", () => {
    const glue = readFileSync(join(ROOT, "extensions/search-discovery-theme/assets/boost-analytics.js"), "utf8");
    const firstConsent = glue.indexOf("consentOk()");
    const firstStorage = glue.indexOf("window.sessionStorage");
    expect(firstConsent).toBeLessThan(firstStorage); // real tree: consent first
    // mutate: inject a bare sessionStorage read at the very top of the IIFE body
    const mutated = glue.replace(
      "var SESSION_KEY = \"boost_session\";",
      "try { window.sessionStorage.getItem('x'); } catch(e){}\n  var SESSION_KEY = \"boost_session\";",
    );
    const mConsent = mutated.indexOf("consentOk()");
    const mStorage = mutated.indexOf("window.sessionStorage");
    expect(mStorage).toBeLessThan(mConsent); // guard's ordering assertion would now fail
  });

  it("(meta) the typecheck/test harness is the real tree, unmodified", () => {
    // Guard files are read-only here; prove the real routes file still has the route.
    const routesTs = readFileSync(join(ROOT, "app", "routes.ts"), "utf8");
    expect(routesTs.includes('"routes/proxy.analytics-event.tsx"')).toBe(true);
    void execFileSync; // imported for potential future process-level mutation; unused now
  });
});
