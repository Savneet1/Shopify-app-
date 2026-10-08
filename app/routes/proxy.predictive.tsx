import type { LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { predictiveSearch } from "~/lib/search/predictive";
import { sanitizeToken } from "~/lib/merch/assign";

/**
 * Predictive (as-you-type) search endpoint (App Proxy).
 * Storefront URL: /apps/<subpath>/predictive?q=...&limit=...
 * Proxied to:     /proxy/predictive
 *
 * Returns a small set of product matches plus catalog-derived suggestions.
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleProxy(request, ({ shopId, url }) =>
    predictiveSearch(shopId, {
      q: url.searchParams.get("q") ?? "",
      limit: numParam(url.searchParams.get("limit")),
      visitorToken: sanitizeToken(url.searchParams.get("abt")), // Phase 8: bounded A/B token
    }),
  );

function numParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
