import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma binding so these unit tests run without the Prisma engine.
const h = vi.hoisted(() => {
  const executed: Array<{ sql: string; args: unknown[] }> = [];
  const fakeTx = {
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      executed.push({ sql, args });
      return 1;
    },
  };
  const fakePrisma = {
    $transaction: async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx),
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      executed.push({ sql, args });
      return [{ id: "resolved-shop-id" }];
    },
  };
  return { executed, fakeTx, fakePrisma };
});

vi.mock("~/db.server", () => ({ getPrisma: () => h.fakePrisma }));

import { withShop, resolveShopId, assertShopDomain, ShopDomainSchema } from "~/lib/tenant.server";
import { RESOLVE_SHOP_SQL, SET_LOCAL_SHOP_SQL } from "~/lib/sql.server";

beforeEach(() => {
  h.executed.length = 0;
});

describe("withShop tenant context", () => {
  it("sets SET LOCAL app.shop_id before running the callback", async () => {
    let sawInsideTx = false;
    const result = await withShop("shop-uuid-123", async () => {
      sawInsideTx = true;
      return "done";
    });
    expect(result).toBe("done");
    expect(sawInsideTx).toBe(true);
    // First statement issued in the tx must be the tenant-context set.
    expect(h.executed[0].sql).toBe(SET_LOCAL_SHOP_SQL);
    expect(h.executed[0].args).toEqual(["shop-uuid-123"]);
    // is_local = true => SET LOCAL semantics (scoped to the transaction).
    expect(SET_LOCAL_SHOP_SQL).toContain("true");
  });

  it("throws if no shopId is provided", async () => {
    await expect(withShop("", async () => 1)).rejects.toThrow(/shopId/);
  });
});

describe("tenant identity validation (never trust arbitrary input)", () => {
  it("accepts a valid myshopify.com domain and normalises it", () => {
    expect(assertShopDomain("  ExAmple.myshopify.com ")).toBe(
      "example.myshopify.com",
    );
  });

  it.each([
    "evil.com",
    "example.myshopify.com.evil.com",
    "'; DROP TABLE shop;--",
    "not a domain",
    "",
  ])("rejects untrusted/invalid domain %j", (bad) => {
    expect(() => assertShopDomain(bad)).toThrow();
    expect(ShopDomainSchema.safeParse(bad).success).toBe(false);
  });

  it("resolveShopId validates BEFORE touching the database", async () => {
    await expect(resolveShopId("evil.com")).rejects.toThrow();
    // No DB call was made for the invalid domain.
    expect(h.executed).toHaveLength(0);
  });

  it("resolveShopId resolves a valid domain via the bootstrap function", async () => {
    const id = await resolveShopId("shop-a.myshopify.com");
    expect(id).toBe("resolved-shop-id");
    expect(h.executed[0].sql).toBe(RESOLVE_SHOP_SQL);
    expect(h.executed[0].args).toEqual(["shop-a.myshopify.com"]);
  });
});
