import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { recordBundleSignal } from "~/lib/bundles/signals";

/**
 * Phase 10.6 — bundle view / add-to-cart beacon (App Proxy).
 * Storefront URL: /apps/<subpath>/bundle-event?bundle=<uuid>&type=<view|add_to_cart>
 * Proxied to:     /proxy/bundle-event
 *
 * Increments ONLY an aggregate per-bundle, per-UTC-day counter
 * (bundle_signal_daily). No visitor id, NO IP, NO per-user row, NO query text,
 * NO logging. The shop is signature-verified (handleProxy); recordBundleSignal
 * validates the bundle id (uuid) and type BEFORE any SQL, requires the bundle to
 * belong to this shop, and silently no-ops otherwise (never throws / never 500s).
 *
 * This beacon is PUBLIC and inflatable — the counts are advisory only (Phase 11
 * analytics supersedes). See docs/PHASE10.md.
 */
async function handle(request: Request) {
  return handleProxy(request, async ({ shopId, url }) => {
    const bundle = url.searchParams.get("bundle") ?? "";
    const type = url.searchParams.get("type") ?? "";
    const recorded = await withShopExec(shopId, (e) => recordBundleSignal(e, shopId, bundle, type));
    return { ok: recorded };
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
export const action = async ({ request }: ActionFunctionArgs) => handle(request);
