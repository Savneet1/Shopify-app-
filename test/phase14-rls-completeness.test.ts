import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type TestDb } from "./helpers/db";

/*
 * Phase 14.4d — RLS COMPLETENESS audit. For EVERY public-schema table that has a
 * shop_id column, assert: RLS is ENABLED and FORCED, at least one row policy
 * exists, and table privileges are granted to app_runtime (and owned by
 * app_owner) only — no PUBLIC grant and no other role — except an explicit,
 * documented allowlist. A new tenant table that forgets RLS or over-grants will
 * fail this test. (The SECURITY DEFINER allowlist is covered by
 * phase11_1-definer.test.ts.)
 */

// Tables with a shop_id column that are intentionally NOT app_runtime-RLS tenant
// tables, each with a reason. (Empty: every shop_id table is a tenant table.)
const RLS_EXEMPT: Record<string, string> = {};

// Roles permitted to hold privileges on a tenant table.
const ALLOWED_GRANTEES = new Set(["app_owner", "app_runtime"]);

describe("Phase 14.4d — RLS completeness", () => {
  let db: TestDb;
  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());

  it("lists the tenant tables (sanity)", async () => {
    const { rows } = await db.ownerPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM information_schema.columns
       WHERE table_schema='public' AND column_name='shop_id'`,
    );
    expect(rows[0].n).toBeGreaterThan(10);
  });

  it("every public table with shop_id has RLS enabled+forced and a policy", async () => {
    const { rows } = await db.ownerPool.query<{ table_name: string; rls: boolean; forced: boolean; policies: number }>(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS rls,
              c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind IN ('r','p')
         AND EXISTS (
           SELECT 1 FROM information_schema.columns col
           WHERE col.table_schema='public' AND col.table_name=c.relname AND col.column_name='shop_id')
       ORDER BY c.relname`,
    );
    const failures: string[] = [];
    for (const r of rows) {
      if (r.table_name in RLS_EXEMPT) continue;
      if (!r.rls) failures.push(`${r.table_name}: RLS not enabled`);
      if (!r.forced) failures.push(`${r.table_name}: RLS not forced`);
      if (r.policies < 1) failures.push(`${r.table_name}: no policy`);
    }
    expect(failures, failures.join("; ")).toEqual([]);
  });

  it("tenant tables grant privileges to app_runtime/app_owner only (no PUBLIC, no stray role)", async () => {
    const { rows } = await db.ownerPool.query<{ table_name: string; grantee: string; privilege_type: string }>(
      `SELECT g.table_name, g.grantee, g.privilege_type
       FROM information_schema.role_table_grants g
       WHERE g.table_schema='public'
         AND EXISTS (
           SELECT 1 FROM information_schema.columns col
           WHERE col.table_schema='public' AND col.table_name=g.table_name AND col.column_name='shop_id')
       ORDER BY g.table_name, g.grantee`,
    );
    const failures: string[] = [];
    for (const r of rows) {
      if (r.table_name in RLS_EXEMPT) continue;
      if (!ALLOWED_GRANTEES.has(r.grantee)) {
        failures.push(`${r.table_name}: unexpected grantee ${r.grantee} (${r.privilege_type})`);
      }
    }
    expect(failures, failures.join("; ")).toEqual([]);
  });
});
