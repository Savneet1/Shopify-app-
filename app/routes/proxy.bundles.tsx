import type { LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { classifyRef } from "~/lib/recommend/refs";
import { isUuid } from "~/lib/merch/assign";
import { listVisibleBundles, resolveBundleForStorefront } from "~/lib/bundles/engine";
import { attachPreorder } from "~/lib/preorder/annotate.server";

/**
 * Phase 10.5 — storefront bundles endpoint (App Proxy).
 * Storefront URL: /apps/<subpath>/bundles?product=<gid|handle>&limit=5
 *                 /apps/<subpath>/bundles?bundle=<uuid>
 * Proxied to:     /proxy/bundles
 *
 * JSON only. Shop identity is signature-verified by handleProxy (per-shop rate
 * limit + never-5xx built in). All input is validated BEFORE any SQL. Only
 * VISIBLE + AVAILABLE bundles are returned (hidden ones never leak), with the
 * card payload shape so the Phase 7.1 URL/image/price handling applies unchanged
 * on the storefront. A junk/foreign id yields an empty list, never an error.
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleProxy(request, async ({ shopId, url }) => {
    const sp = url.searchParams;
    const bundleId = sp.get("bundle");
    const productRaw = sp.get("product");
    const limit = numParam(sp.get("limit"));

    // Single bundle by id.
    if (bundleId != null) {
      if (!isUuid(bundleId)) return { bundles: [], total: 0 };
      const payload = await withShopExec(shopId, async (e) => {
        const p = await resolveBundleForStorefront(e, shopId, bundleId);
        if (p) await attachPreorder(e, shopId, p.items.map((i) => i.product), new Date());
        return p;
      });
      return { bundles: payload ? [payload] : [], total: payload ? 1 : 0 };
    }

    // Optional product-ref filter: a present-but-invalid ref returns nothing
    // (never "all bundles" for junk input).
    let productRef: string | null = null;
    if (productRaw != null && productRaw !== "") {
      const ref = classifyRef(productRaw);
      if (!ref || (ref.kind !== "gid" && ref.kind !== "handle")) return { bundles: [], total: 0 };
      productRef = ref.value;
    }

    const bundles = await withShopExec(shopId, async (e) => {
      const list = await listVisibleBundles(e, shopId, { productRef, limit });
      const products = list.flatMap((b) => (b.items ?? []).map((i) => i.product));
      await attachPreorder(e, shopId, products, new Date());
      return list;
    });
    return { bundles, total: bundles.length };
  });

function numParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
