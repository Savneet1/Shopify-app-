import type { LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { suggest } from "~/lib/search/suggest";

/**
 * Catalog-derived suggestions endpoint (App Proxy).
 * Storefront URL: /apps/<subpath>/suggest?q=...&limit=...
 * Proxied to:     /proxy/suggest
 *
 * Returns catalog-derived term suggestions (titles/vendors/types/collections).
 * NOT popularity-based (that is Phase 11).
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleProxy(request, ({ shopId, url }) =>
    suggest(shopId, {
      q: url.searchParams.get("q") ?? "",
      limit: numParam(url.searchParams.get("limit")),
    }),
  );

function numParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
