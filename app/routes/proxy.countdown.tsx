import type { LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { resolveCountdown } from "~/lib/countdown/resolve.server";

/**
 * Phase 12.5 — storefront countdown endpoint (App Proxy).
 * Storefront URL: /apps/<subpath>/countdown?product=<gid|handle>
 * Proxied to:     /proxy/countdown
 *
 * JSON only. Shop identity is signature-verified by handleProxy. Returns the
 * applicable countdown ({ endsAt, serverNow, label, expiredMessage, expired })
 * or { countdown: null } when none applies / no rules. serverNow lets the client
 * correct for clock skew. Display only — no price/checkout effect.
 */
export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleProxy(request, async ({ shopId, url }) => {
    const productRef = url.searchParams.get("product");
    const countdown = await withShopExec(shopId, (e) => resolveCountdown(e, shopId, productRef, new Date()));
    return { countdown };
  });
