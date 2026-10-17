import type { LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { getRecommendations, normalizeRecType } from "~/lib/recommend/engine";
import { attachPreorder } from "~/lib/preorder/annotate.server";

/**
 * Phase 9.5 — storefront recommendations endpoint (App Proxy).
 * Storefront URL: /apps/<subpath>/recommendations?type=similar&seed=<handle|gid>&limit=8&recent=a,b,c
 * Proxied to:     /proxy/recommendations
 *
 * JSON only. Shop identity is signature-verified by handleProxy (per-shop rate
 * limit + never-5xx-to-storefront built in). Every value is validated inside the
 * engine before SQL; a bad/unknown seed yields an empty product list, never an
 * error. The payload mirrors the search result cards (title/url/image/price
 * range/vendor/availability) so the Phase 7.1 URL/image/price handling applies
 * unchanged on the storefront.
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleProxy(request, async ({ shopId, url }) => {
    const sp = url.searchParams;
    const type = normalizeRecType(sp.get("type")) ?? "trending";
    const ranking = sp.get("ranking") === "lift" ? "lift" : "confidence";
    const res = await withShopExec(shopId, async (e) => {
      const r = await getRecommendations(e, shopId, {
        type,
        seed: sp.get("seed"),
        recent: sp.get("recent"),
        limit: numParam(sp.get("limit")),
        fbtRanking: ranking,
      });
      // Phase 12.4: additively attach pre-order badges (no-op without rules).
      await attachPreorder(e, shopId, r.products as Array<{ id: string }>, new Date());
      return r;
    });
    // Shape mirrors proxy/products cards; `fallback` absent means "rendered".
    return {
      type: res.type,
      seed: res.seed,
      products: res.products,
      total: res.products.length,
      fellBackTo: res.fellBackTo,
      reason: res.reason,
    };
  });

function numParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
