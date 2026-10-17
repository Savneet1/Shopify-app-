import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { withShopExec } from "~/lib/tenant.server";
import { subscribe } from "~/lib/restock/subscriptions";
import { sendConfirmationEmail } from "~/lib/restock/send.server";

/**
 * Phase 12.2 — back-in-stock subscription capture (App Proxy).
 * Storefront URL: /apps/<subpath>/back-in-stock   (POST JSON)
 * Proxied to:     /proxy/back-in-stock
 *
 * Body: { email, productGid, variantGid?, locale?, consent, consentTextVersion?, source? }
 * Shop is signature-verified by handleProxy (per-shop rate limit + never-5xx).
 * ALL input is validated before any SQL. The response is GENERIC and IDENTICAL
 * whether the email is new, already subscribed, suppressed, capped, or the
 * product is not applicable — it never reveals whether a subscription exists.
 * On a freshly created row a double-opt-in confirmation email is sent (if email
 * is configured) BEFORE any alert is ever possible.
 */
const MAX_BODY_BYTES = 4 * 1024;

const GENERIC = { ok: true, status: "received" as const };

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.clone().text();
    if (text.length > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function handle(request: Request) {
  const body = await readBody(request);
  return handleProxy(request, async ({ shopId }) => {
    if (!body) return GENERIC; // malformed/oversized → generic (never reveals anything)
    const result = await withShopExec(shopId, (e) =>
      subscribe(e, shopId, {
        email: body.email,
        productGid: body.productGid,
        variantGid: body.variantGid,
        locale: body.locale,
        consent: body.consent,
        consentTextVersion: body.consentTextVersion,
        source: body.source,
      }),
    );
    // Only a freshly created row triggers a confirmation email (double opt-in).
    if (result.outcome === "created" && result.subscriptionId && result.confirmToken && result.email) {
      await withShopExec(shopId, (e) =>
        sendConfirmationEmail(e, shopId, result.subscriptionId!, result.confirmToken!, result.email!),
      ).catch(() => {});
    }
    return GENERIC; // identical response for every outcome
  });
}

export const action = async ({ request }: ActionFunctionArgs) => handle(request);
export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
