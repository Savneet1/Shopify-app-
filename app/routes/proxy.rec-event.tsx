import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";
import { recordSignal } from "~/lib/recommend/signals";

/**
 * Phase 9.2 — product view/click signal beacon (App Proxy).
 * Storefront URL: /apps/<subpath>/rec-event?product=<handle|gid>&type=<view|click>
 * Proxied to:     /proxy/rec-event
 *
 * Increments ONLY an aggregate per-product, per-UTC-day counter
 * (product_signal_daily). No visitor id, NO IP, NO per-user row, NO query text,
 * NO logging. The shop is signature-verified (handleProxy); recordSignal
 * validates the product ref and type BEFORE any SQL, resolves the ref to a
 * visible product of this shop, and silently no-ops on anything else (never
 * throws / never 500s). GET and POST both accepted (sendBeacon uses POST).
 *
 * This beacon is PUBLIC and inflatable — the counts are advisory (a trending
 * heuristic), never authoritative. See docs/PHASE9.md.
 */
async function handle(request: Request) {
  return handleProxy(request, async ({ shopId, url }) => {
    const product = url.searchParams.get("product") ?? "";
    const type = url.searchParams.get("type") ?? "";
    const recorded = await withShopExec(shopId, async (e) => {
      const active = await getActiveVersion(e, shopId);
      return recordSignal(e, shopId, active?.id ?? null, product, type);
    });
    return { ok: recorded };
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
export const action = async ({ request }: ActionFunctionArgs) => handle(request);
