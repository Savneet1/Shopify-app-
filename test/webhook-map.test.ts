import { describe, expect, it } from "vitest";
import { mapCatalogWebhook } from "~/lib/catalog/webhook-map";

const SHOP = "11111111-1111-1111-1111-111111111111";

describe("catalog webhook -> entity-changed mapping (re-fetch design)", () => {
  it("maps products/update to a product re-fetch job by GID", () => {
    const mapped = mapCatalogWebhook("products/update", { id: 123 }, SHOP, "wh-1");
    expect(mapped).toEqual({
      shopId: SHOP,
      dedupeKey: "PRODUCTS_UPDATE:wh-1",
      entity: "product",
      gid: "gid://shopify/Product/123",
    });
  });

  it("maps products/delete to a product re-fetch job (delete detected by re-fetch)", () => {
    const mapped = mapCatalogWebhook("products/delete", { id: 9 }, SHOP, "wh-2");
    expect(mapped).toMatchObject({ entity: "product", gid: "gid://shopify/Product/9" });
  });

  it("maps collections/update to a collection re-fetch job", () => {
    const mapped = mapCatalogWebhook("collections/update", { id: 77 }, SHOP, "wh-3");
    expect(mapped).toMatchObject({ entity: "collection", gid: "gid://shopify/Collection/77" });
  });

  it("returns null for an unrelated topic", () => {
    expect(mapCatalogWebhook("app/uninstalled", {}, SHOP, "wh-4")).toBeNull();
  });
});
