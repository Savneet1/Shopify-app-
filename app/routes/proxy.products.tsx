import type { LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { storefrontSearch } from "~/lib/search/storefront";

/**
 * Storefront full-text search endpoint (App Proxy).
 * Storefront URL: /apps/<subpath>/products?q=...&limit=...&offset=...
 * Proxied to:     /proxy/products
 *
 * JSON only. Shop identity is signature-verified (see handleProxy). Returns the
 * storefront search contract: products[], total, strategy, indexVersion,
 * fallback ("native"|null), zeroResult, suggestions[].
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleProxy(request, ({ shopId, url }) =>
    storefrontSearch(shopId, {
      q: url.searchParams.get("q") ?? "",
      limit: numParam(url.searchParams.get("limit")),
      offset: numParam(url.searchParams.get("offset")),
    }),
  );

function numParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
