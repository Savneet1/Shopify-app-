import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase 13.4 — B2B honesty. Without read_companies / read_customers scopes the
 * app cannot know a company's catalog or negotiated prices, so it must NOT
 * pretend to: it never uses or stores logged_in_customer_id, and no per-customer
 * price path exists. This static check fails if any server file starts
 * consuming logged_in_customer_id.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe("Phase 13.4 — no B2B per-customer pricing is faked", () => {
  const APP = join(__dirname, "..", "app");
  const files = walk(APP);

  it("no server file consumes logged_in_customer_id (only documented in comments)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Allow the word to appear ONLY inside a comment that documents the
      // decision (hints.ts). Flag any code reference (assignment, param read).
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!/logged_in_customer_id|loggedInCustomerId/.test(l)) continue;
        const trimmed = l.trim();
        const isComment = trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
        if (!isComment) offenders.push(`${f.replace(APP, "app")}:${i + 1}`);
      }
    }
    expect(offenders, `B2B rule: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no customer-scoped pricing table/column exists in migrations", () => {
    const MIG = join(__dirname, "..", "prisma", "migrations");
    const dirs = readdirSync(MIG).filter((d) => statSync(join(MIG, d)).isDirectory());
    for (const d of dirs) {
      const sql = readFileSync(join(MIG, d, "migration.sql"), "utf8");
      expect(/customer_price|negotiated_price|company_catalog/i.test(sql)).toBe(false);
    }
  });
});
