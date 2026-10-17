import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { withShopExec } from "~/lib/tenant.server";
import { unsubscribe } from "~/lib/restock/subscriptions";

/**
 * Phase 12.3 — public UNSUBSCRIBE link + one-click endpoint (clicked from the
 * email, or POSTed by an RFC 8058 one-click mail client; no login). Params:
 * s=<subscriptionId> sid=<shopId uuid> t=<derived unsubscribe token>. Idempotent
 * (already-unsubscribed still reports success). Adds a suppression record so the
 * address is never re-mailed. The response is generic HTML and NEVER reveals
 * whether the subscription exists. Never throws / 5xx.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function doUnsub(request: Request): Promise<void> {
  const url = new URL(request.url);
  const s = url.searchParams.get("s") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const t = url.searchParams.get("t") ?? "";
  if (!UUID.test(s) || !UUID.test(sid) || t.length === 0 || t.length > 512) return;
  try {
    await withShopExec(sid, (e) => unsubscribe(e, sid, s, t));
  } catch {
    /* never surface an error */
  }
}

function page(message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Back-in-stock alerts</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Back-in-stock alerts</h1><p>${message}</p></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const GENERIC = "If you were subscribed, you have been unsubscribed and will no longer receive these alerts.";

// GET: a human clicked the link.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await doUnsub(request);
  return page(GENERIC);
};

// POST: RFC 8058 List-Unsubscribe one-click (body "List-Unsubscribe=One-Click").
export const action = async ({ request }: ActionFunctionArgs) => {
  await doUnsub(request);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
};
