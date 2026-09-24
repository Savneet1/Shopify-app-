import "@shopify/shopify-api/adapters/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { shopifyApi, ApiVersion } from "@shopify/shopify-api";
import { makeDb, type TestDb } from "./helpers/db";
import { upsertProduct, upsertVariant } from "~/lib/catalog/store";
import {
  createIndexVersion, buildDocs, validateIndexVersion, activateIndexVersion,
} from "~/lib/index/engine";
import { searchWithExec } from "~/lib/search/query";

const SECRET = "shpss_appproxy_secret";

const api = shopifyApi({
  apiKey: "test-key",
  apiSecretKey: SECRET,
  scopes: ["read_products"],
  hostName: "localhost",
  apiVersion: ApiVersion.July26,
  isEmbeddedApp: true,
});

/**
 * Sign an App Proxy query exactly as Shopify does: drop hmac/signature, sort
 * params by key, concatenate `key=value` with NO separator, HMAC-SHA256 (hex).
 * (Matches @shopify/shopify-api stringifyQueryForAppProxy.)
 */
function signAppProxy(params: Record<string, string>, secret = SECRET): string {
  const { signature: _s, hmac: _h, ...rest } = params as any;
  void _s; void _h;
  const msg = Object.entries(rest)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

function proxyParams(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    shop: "shop-a.myshopify.com",
    path_prefix: "/apps/search",
    timestamp: String(Math.trunc(Date.now() / 1000)),
    logged_in_customer_id: "",
    ...over,
  };
}

describe("Phase 3 — App Proxy signature verification (real @shopify/shopify-api)", () => {
  it("accepts a correctly signed request", async () => {
    const params = proxyParams();
    params.signature = signAppProxy(params);
    const valid = await api.utils.validateHmac(params, { signator: "appProxy" });
    expect(valid).toBe(true);
  });

  it("rejects an invalid/forged signature", async () => {
    const params = proxyParams();
    params.signature = "deadbeef".repeat(8);
    const valid = await api.utils.validateHmac(params, { signator: "appProxy" });
    expect(valid).toBe(false);
  });

  it("rejects a request whose ?shop was tampered after signing (shop is in the signed payload)", async () => {
    const params = proxyParams();
    params.signature = signAppProxy(params); // signed for shop-a
    // Attacker swaps the shop to point at another tenant, keeping the signature.
    const tampered = { ...params, shop: "victim.myshopify.com" };
    const valid = await api.utils.validateHmac(tampered, { signator: "appProxy" });
    expect(valid).toBe(false);
  });

  it("rejects when an extra query param is added after signing", async () => {
    const params = proxyParams();
    params.signature = signAppProxy(params);
    const tampered = { ...params, q: "injected" };
    const valid = await api.utils.validateHmac(tampered, { signator: "appProxy" });
    expect(valid).toBe(false);
  });

  it("throws when the signature is missing entirely", async () => {
    const params = proxyParams();
    await expect(
      api.utils.validateHmac(params, { signator: "appProxy" }),
    ).rejects.toThrow();
  });

  it("a valid signature is derived from the shop, so the verified shop is the only usable tenant id", async () => {
    // Sign for shop-b; verifying against shop-b succeeds, and the same signature
    // fails for any other shop value -> the caller can only ever act as shop-b.
    const params = proxyParams({ shop: "shop-b.myshopify.com" });
    params.signature = signAppProxy(params);
    expect(await api.utils.validateHmac(params, { signator: "appProxy" })).toBe(true);
    expect(
      await api.utils.validateHmac({ ...params, shop: "shop-a.myshopify.com" }, { signator: "appProxy" }),
    ).toBe(false);
  });
});

describe("Phase 3 — cross-shop isolation in the search layer", () => {
  let db: TestDb;
  let shopA: string;
  let shopB: string;

  beforeAll(() => { db = makeDb(); });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.resetDb();
    shopA = await db.resolveShop("iso-a.myshopify.com");
    shopB = await db.resolveShop("iso-b.myshopify.com");

    // Both shops have a product matching the same term "gadget".
    for (const [shop, tag] of [[shopA, "A"], [shopB, "B"]] as const) {
      await db.withShopExec(shop, async (e) => {
        const { id } = await upsertProduct(e, shop, {
          shopifyProductGid: `gid://shopify/Product/${tag}1`,
          title: `Gadget ${tag}`, status: "ACTIVE",
          onlineStoreUrl: `https://${tag}.test/gadget`,
        });
        await upsertVariant(e, shop, id, { shopifyVariantGid: `gid://shopify/ProductVariant/${tag}1`, sku: `SKU-${tag}`, price: "5.00", availableForSale: true });
      });
      const v = await db.withShopExec(shop, (e) => createIndexVersion(e, shop, "full", 1));
      await db.withShopExec(shop, (e) => buildDocs(e, shop, v.id));
      await db.withShopExec(shop, (e) => validateIndexVersion(e, shop, v.id, 1));
      await db.withShopExec(shop, (e) => activateIndexVersion(e, shop, v.id));
    }
  });

  it("a search under shop A never returns shop B's products", async () => {
    const rA = await db.withShopExec(shopA, (e) => searchWithExec(e, shopA, { q: "gadget" }));
    expect(rA.products.map((p) => p.title)).toEqual(["Gadget A"]);
    expect(rA.total).toBe(1);

    const rB = await db.withShopExec(shopB, (e) => searchWithExec(e, shopB, { q: "gadget" }));
    expect(rB.products.map((p) => p.title)).toEqual(["Gadget B"]);
  });

  it("shop A cannot read shop B's docs even given B's version id (RLS)", async () => {
    // Grab B's active version id (from B's context).
    const bVersion = await db.withShopExec(shopB, async (e) =>
      (await e.rows<{ id: string }>("SELECT id FROM index_version WHERE shop_id=$1::uuid AND status='active'", [shopB]))[0].id,
    );
    // Under A's tenant context, directly query product_search_doc for B's version.
    const leaked = await db.withShopExec(shopA, (e) =>
      e.rows<{ n: number }>(
        "SELECT count(*)::int n FROM product_search_doc WHERE index_version_id=$1::uuid",
        [bVersion],
      ),
    );
    expect(leaked[0].n).toBe(0);
  });
});
