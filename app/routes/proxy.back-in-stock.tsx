import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { enqueueRestockConfirm } from "~/lib/jobs/queue";
import { runSubscribeRequest } from "~/lib/restock/subscribe-request.server";

/**
 * Phase 12.2 / 12.1 Q2 — back-in-stock subscription capture (App Proxy).
 *
 * Body: { email, productGid, variantGid?, locale?, consent, consentTextVersion?, source? }
 * Shop is signature-verified by handleProxy (per-shop rate limit + never-5xx).
 * ALL input is validated before any SQL. The response is GENERIC and IDENTICAL
 * whether the email is new, already subscribed, suppressed, capped, or the
 * product is not applicable.
 *
 * Q2 fixes:
 *  - NO outbound network I/O in this request: a freshly created row only ENQUEUES
 *    a confirmation job (payload = opaque ids); the worker sends the email. This
 *    removes the 60–100× "new vs already-subscribed" timing oracle and the risk
 *    of a slow/hanging SMTP host holding the request open.
 *  - A deterministic minimum response time (RESPONSE_FLOOR_MS) is applied to
 *    EVERY outcome, masking the sub-millisecond "enqueued vs exists" difference.
 */
const MAX_BODY_BYTES = 4 * 1024;

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.clone().text();
    if (text.length > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}

async function handle(request: Request) {
  const body = await readBody(request);
  return handleProxy(request, async ({ shopId }) => {
    const started = Date.now();
    return withShopExec(shopId, (e) =>
      runSubscribeRequest(e, shopId, body, { enqueueConfirm: enqueueRestockConfirm, startedMs: started }),
    );
  });
}

export const action = async ({ request }: ActionFunctionArgs) => handle(request);
export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
