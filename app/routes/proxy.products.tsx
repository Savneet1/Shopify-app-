import type { LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { storefrontSearch } from "~/lib/search/storefront";
import { filtersFromSearchParams } from "~/lib/search/params";

/**
 * Storefront search + filters endpoint (App Proxy).
 * Storefront URL: /apps/<subpath>/products?q=...&vendor=...&tags=...&priceMin=...
 * Proxied to:     /proxy/products
 *
 * JSON only. Shop identity is signature-verified (see handleProxy). Returns
 * { products, total, facets, appliedFilters, priceRange, strategy, indexVersion,
 * fallback, zeroResult, suggestions }. Malformed filters -> 400 (handleProxy).
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleProxy(request, ({ shopId, url }) =>
    storefrontSearch(shopId, {
      q: url.searchParams.get("q") ?? "",
      limit: numParam(url.searchParams.get("limit")),
      offset: numParam(url.searchParams.get("offset")),
      filters: filtersFromSearchParams(url.searchParams),
    }),
  );

function numParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
