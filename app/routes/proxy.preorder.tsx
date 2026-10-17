import type { LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { resolvePreorder } from "~/lib/preorder/annotate.server";

/**
 * Phase 12.4 — storefront pre-order lookup for the product block (App Proxy).
 * Storefront URL: /apps/<subpath>/preorder?product=<gid|handle>
 * Proxied to:     /proxy/preorder
 *
 * JSON only. Shop identity is signature-verified by handleProxy. Returns the
 * applicable pre-order badge ({ preorder:true, message, releaseAt }) or
 * { preorder: null } when no enabled, in-window rule matches / no rules.
 * DISPLAY ONLY — this never changes inventory policy, selling plans or
 * checkout. Never 5xx; hostile/absent refs resolve to { preorder: null }.
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleProxy(request, async ({ shopId, url }) => {
    const productRef = url.searchParams.get("product");
    const preorder = await withShopExec(shopId, (e) => resolvePreorder(e, shopId, productRef, new Date()));
    return { preorder };
  });
