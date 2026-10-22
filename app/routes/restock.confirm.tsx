import type { LoaderFunctionArgs } from "react-router";
import { withShopExec } from "~/lib/tenant.server";
import { confirmSubscription } from "~/lib/restock/subscriptions";
import { RESPONSE_FLOOR_MS, applyResponseFloor } from "~/lib/restock/timing";

/**
 * Phase 12.2 — public double-opt-in CONFIRM link (clicked from the email; no
 * login). Params: s=<subscriptionId> sid=<shopId uuid> t=<raw confirm token>.
 * The shop id binds RLS context directly (no domain->id lookup, so no shop row
 * is ever created from a forged link). The response is a plain, generic HTML
 * page and NEVER reveals whether the subscription exists. Never throws / 5xx.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Back-in-stock alerts</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Back-in-stock alerts</h1><p>${message}</p></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const s = url.searchParams.get("s") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const t = url.searchParams.get("t") ?? "";
  // Generic message regardless of outcome (never reveals existence).
  const generic = "If your request was valid, your back-in-stock alert is now confirmed. You can close this page.";
  const started = Date.now();
  if (!UUID.test(s) || !UUID.test(sid) || t.length === 0 || t.length > 512) {
    // Pad even the malformed-input path so timing never distinguishes outcomes.
    await applyResponseFloor(started, RESPONSE_FLOOR_MS);
    return page(generic);
  }
  try {
    await withShopExec(sid, (e) => confirmSubscription(e, sid, s, t));
  } catch {
    /* never surface an error */
  }
  // Equalise timing across unknown / used / expired / valid tokens.
  await applyResponseFloor(started, RESPONSE_FLOOR_MS);
  return page(generic);
};
