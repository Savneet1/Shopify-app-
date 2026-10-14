import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { ingestEvents } from "~/lib/analytics/store";

/**
 * Phase 11.3 — analytics ingestion beacon (App Proxy).
 * Storefront URL: /apps/<subpath>/analytics-event   (POST a JSON batch)
 * Proxied to:     /proxy/analytics-event
 *
 * Body: { events: RawEvent[] }  (<= 20 events, hard body-size cap). Shop is
 * signature-verified by handleProxy (per-shop rate limit + never-5xx). Every
 * field of every event is validated BEFORE any SQL; invalid events are dropped
 * individually. occurred_at is ALWAYS the server clock — any client timestamp
 * in the payload is ignored. Respects analytics_mode (off → stores nothing).
 * Returns { accepted, rejected }. Never throws / never 5xx on hostile input.
 */
const MAX_BODY_BYTES = 16 * 1024;

async function readBatch(request: Request): Promise<unknown> {
  try {
    // Clone so handleProxy can still read the signed URL for verification.
    const text = await request.clone().text();
    if (text.length > MAX_BODY_BYTES) return null; // body-size cap → whole batch rejected
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).events)) {
      return (parsed as any).events;
    }
    return null;
  } catch {
    return null;
  }
}

async function handle(request: Request) {
  const events = await readBatch(request);
  return handleProxy(request, async ({ shopId }) => {
    if (events == null) return { accepted: 0, rejected: 0 };
    const res = await withShopExec(shopId, (e) => ingestEvents(e, shopId, events));
    return { accepted: res.accepted, rejected: res.rejected };
  });
}

export const action = async ({ request }: ActionFunctionArgs) => handle(request);
// A GET is accepted too (sendBeacon can only POST, but keep parity with the
// other beacons); with no body it simply accepts nothing.
export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
