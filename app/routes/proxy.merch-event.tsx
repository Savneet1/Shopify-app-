import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { recordEvent } from "~/lib/merch/experiments";

/**
 * Phase 8.5 — A/B aggregate exposure/click beacon (App Proxy).
 * Storefront URL: /apps/<subpath>/merch-event?experiment=<id>&variant=<A|B|control>&type=<exposure|click>
 * Proxied to:     /proxy/merch-event
 *
 * Increments ONLY an aggregate counter (ab_exposure) for the experiment+variant.
 * No per-user rows, no PII, no query text, no IP. The shop is signature-verified
 * (handleProxy); recordEvent validates the experiment is running and the variant
 * is known, and silently no-ops otherwise. GET and POST both accepted (beacons /
 * sendBeacon use POST; a GET fallback keeps it simple).
 */
function readParams(url: URL) {
  const sp = url.searchParams;
  return {
    experimentId: sp.get("experiment") ?? "",
    variant: sp.get("variant") ?? "",
    type: sp.get("type") === "click" ? "click" : "exposure",
  } as const;
}

async function handle(request: Request) {
  return handleProxy(request, async ({ shopId, url }) => {
    const { experimentId, variant, type } = readParams(url);
    let recorded = false;
    if (experimentId) {
      recorded = await withShopExec(shopId, (e) => recordEvent(e, shopId, experimentId, variant, type));
    }
    return { ok: recorded };
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
export const action = async ({ request }: ActionFunctionArgs) => handle(request);
