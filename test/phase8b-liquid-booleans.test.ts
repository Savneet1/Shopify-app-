import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase 8.1b J1 — merchant checkbox toggles must be switch-off-able.
 * Shopify Liquid's `default` filter also replaces a FALSE value (unless
 * allow_false: true), so `{{ block.settings.x | default: true | json }}` makes an
 * unchecked box still emit true and the feature cannot be disabled. These static
 * checks fail if any checkbox setting is rendered through `| default:` without
 * allow_false, and confirm the config uses the explicit if/else form instead.
 */
const BLOCKS = join(__dirname, "..", "extensions", "search-discovery-theme", "blocks");

function schemaOf(src: string): any {
  const m = src.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
  if (!m) throw new Error("no schema block");
  return JSON.parse(m[1]);
}
function bodyOf(src: string): string {
  return src.split(/\{%\s*schema\s*%\}/)[0]; // config JSON lives before the schema
}

describe("Phase 8.1b — checkbox toggles are switch-off-able (J1)", () => {
  const files = readdirSync(BLOCKS).filter((f) => f.endsWith(".liquid"));
  expect(files.length).toBeGreaterThan(0);

  for (const f of files) {
    const src = readFileSync(join(BLOCKS, f), "utf8");
    const schema = schemaOf(src);
    const body = bodyOf(src);
    const checkboxes: { id: string; default: boolean }[] = (schema.settings || [])
      .filter((s: any) => s && s.type === "checkbox" && typeof s.id === "string")
      // Shopify treats a checkbox with no `default` as unchecked (false).
      .map((s: any) => ({ id: s.id, default: s.default === true }));

    it(`${f}: every checkbox renders via the if/else form matching its schema default`, () => {
      for (const { id, default: dflt } of checkboxes) {
        // (1) No `block.settings.<id> | default: true|false` without allow_false.
        const badDefault = new RegExp(`block\\.settings\\.${id}\\s*\\|\\s*default:\\s*(?:true|false)(?![^}]*allow_false:\\s*true)`);
        expect(badDefault.test(body), `${f}: '${id}' uses an unsafe | default: filter`).toBe(false);
        // (2) K4: the explicit form must make the UNSET value equal the schema
        // default. default:true → `== false` (unset → true); default:false →
        // `== true` (unset → false).
        const falseForm = new RegExp(`\\{%\\s*if\\s+block\\.settings\\.${id}\\s*==\\s*false\\s*%\\}`);
        const trueForm = new RegExp(`\\{%\\s*if\\s+block\\.settings\\.${id}\\s*==\\s*true\\s*%\\}`);
        if (dflt) {
          expect(falseForm.test(body), `${f}: default-true '${id}' must use the '== false' form`).toBe(true);
          expect(trueForm.test(body), `${f}: default-true '${id}' must NOT use the '== true' form`).toBe(false);
        } else {
          expect(trueForm.test(body), `${f}: default-false '${id}' must use the '== true' form`).toBe(true);
          expect(falseForm.test(body), `${f}: default-false '${id}' must NOT use the '== false' form`).toBe(false);
        }
      }
    });
  }

  it("the four known boolean settings are covered", () => {
    const results = readFileSync(join(BLOCKS, "boost-results.liquid"), "utf8");
    const predictive = readFileSync(join(BLOCKS, "boost-predictive.liquid"), "utf8");
    for (const id of ["nl_enabled", "show_banners", "ab_testing"]) {
      expect(new RegExp(`\\{%\\s*if\\s+block\\.settings\\.${id}\\s*==\\s*false\\s*%\\}`).test(results), `results:${id}`).toBe(true);
    }
    expect(/\{%\s*if\s+block\.settings\.ab_testing\s*==\s*false\s*%\}/.test(predictive)).toBe(true);
  });

  it("no .liquid block applies | default: true/false to any checkbox id (global sweep)", () => {
    for (const f of readdirSync(BLOCKS).filter((x) => x.endsWith(".liquid"))) {
      const src = readFileSync(join(BLOCKS, f), "utf8");
      const schema = schemaOf(src);
      const body = bodyOf(src);
      const checkboxIds = (schema.settings || []).filter((s: any) => s && s.type === "checkbox").map((s: any) => s.id);
      const defaults = body.match(/block\.settings\.[a-z0-9_]+\s*\|\s*default:\s*(?:true|false)/g) || [];
      for (const d of defaults) {
        const id = d.match(/block\.settings\.([a-z0-9_]+)/)![1];
        expect(checkboxIds.includes(id), `${f}: checkbox '${id}' must not use | default:`).toBe(false);
      }
    }
  });
});
