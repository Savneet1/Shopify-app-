import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDb, type TestDb } from "./helpers/db";

/*
 * Phase 14.4a — default statement_timeout on PUBLIC proxy query paths. A
 * pathological query must be cancelled by PostgreSQL (SQLSTATE 57014) rather
 * than hold the database; the proxy handler's catch then returns a clean native
 * fallback (200), never a 5xx.
 *
 * Two layers:
 *  - MECHANISM (against real PostgreSQL via the node-pg harness, the identical
 *    `SET LOCAL statement_timeout` SQL the Prisma path issues): a slow query is
 *    cancelled, and the error is the catchable 57014 — not an unhandled crash.
 *  - WIRING (static): every public proxy route reaches the DB through a
 *    timeout-bounded exec (withShopExecTimed, or a module that sets its own
 *    SET LOCAL statement_timeout).
 */

describe("Phase 14.4a — statement_timeout mechanism (real PostgreSQL)", () => {
  let db: TestDb; let shop: string;
  beforeAll(async () => { db = makeDb(); shop = await db.resolveShop("p14timeout.myshopify.com"); });
  afterAll(() => db.close());

  it("a short SET LOCAL statement_timeout cancels a slow query with 57014", async () => {
    let code: string | undefined;
    try {
      await db.withShopClient(shop, async (client) => {
        await client.query("SET LOCAL statement_timeout = 200");
        await client.query("SELECT pg_sleep(2)"); // 2s > 200ms → cancelled
      });
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("57014"); // query_canceled — a catchable error, not a hang
  });

  it("a fast query under the same timeout succeeds", async () => {
    const ok = await db.withShopClient(shop, async (client) => {
      await client.query("SET LOCAL statement_timeout = 2000");
      const r = await client.query("SELECT 1 AS one");
      return r.rows[0].one;
    });
    expect(ok).toBe(1);
  });
});

describe("Phase 14.4a — every public proxy path is timeout-bounded (wiring)", () => {
  const ROUTES = join(__dirname, "..", "app", "routes");
  const PUBLIC_PROXY = [
    "proxy.products", "proxy.predictive", "proxy.suggest", "proxy.recommendations",
    "proxy.bundles", "proxy.back-in-stock", "proxy.countdown", "proxy.preorder",
    "proxy.merch-event", "proxy.rec-event", "proxy.bundle-event", "proxy.analytics-event",
  ];
  it("each proxy route's DB access is bounded (withShopExecTimed or an own SET LOCAL statement_timeout)", () => {
    const offenders: string[] = [];
    for (const name of PUBLIC_PROXY) {
      const src = readFileSync(join(ROUTES, `${name}.tsx`), "utf8");
      const usesTimed = src.includes("withShopExecTimed");
      // products/predictive/suggest/recommendations set SET LOCAL inside the
      // called module; those modules carry it. Accept either signal.
      const callsBoundedModule = /predictiveSearch|storefrontSearch|\bsuggest\b|getRecommendations/.test(src);
      if (!usesTimed && !callsBoundedModule) offenders.push(name);
    }
    expect(offenders, `unbounded proxy paths: ${offenders.join(", ")}`).toEqual([]);
  });
  it("the search/predictive/suggest/recommend modules set a statement_timeout", () => {
    const base = join(__dirname, "..", "app", "lib");
    for (const f of ["search/storefront.ts", "search/predictive.ts", "search/suggest.ts", "recommend/engine.ts"]) {
      expect(readFileSync(join(base, f), "utf8"), `${f} must bound its queries`).toContain("statement_timeout");
    }
  });
});
