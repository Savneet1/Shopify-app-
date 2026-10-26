import type { Exec } from "~/lib/db/executor";
import { subscribe } from "./subscriptions";
import { RESPONSE_FLOOR_MS, applyResponseFloor } from "./timing";

/**
 * Phase 12.1 Q2 — the back-in-stock subscribe request-path logic, in a module
 * with NO Prisma / App-Proxy imports so it is directly unit-testable. The route
 * (proxy.back-in-stock) wraps this with handleProxy + withShopExec + the real
 * enqueue. There is NO outbound email I/O here: a freshly created row only
 * enqueues an async confirmation job; every outcome is padded to a fixed
 * response-time floor so timing never reveals whether a subscription exists.
 */
export const SUBSCRIBE_GENERIC = { ok: true, status: "received" as const };

export interface SubscribeRequestDeps {
  /** Enqueue the async confirmation (payload = opaque ids only). Injectable. */
  enqueueConfirm: (shopId: string, subscriptionId: string) => Promise<unknown>;
  startedMs: number;
  floorMs?: number;
  /** Optional hook for a failed/slow enqueue (logging). The sweeper recovers it. */
  onEnqueueError?: (err: unknown) => void;
}

export async function runSubscribeRequest(
  exec: Exec, shopId: string, body: Record<string, unknown> | null, deps: SubscribeRequestDeps,
): Promise<typeof SUBSCRIBE_GENERIC> {
  if (body) {
    const result = await subscribe(exec, shopId, {
      email: body.email, productGid: body.productGid, variantGid: body.variantGid,
      locale: body.locale, consent: body.consent, consentTextVersion: body.consentTextVersion, source: body.source,
    }).catch(() => ({ outcome: "rejected" as const }));
    if (result.outcome === "created" && "subscriptionId" in result && result.subscriptionId) {
      // Fire-and-forget: the enqueue must NEVER extend the response past the
      // floor (a slow queue would otherwise reopen a timing signal and hold the
      // request). If it is slow or fails, the maintenance-tick sweeper
      // (runRestockConfirmSweep) re-enqueues the stranded row. The subscription
      // id is already committed, so nothing is lost.
      void Promise.resolve()
        .then(() => deps.enqueueConfirm(shopId, (result as { subscriptionId: string }).subscriptionId))
        .catch((err) => deps.onEnqueueError?.(err));
    }
  }
  await applyResponseFloor(deps.startedMs, deps.floorMs ?? RESPONSE_FLOOR_MS);
  return SUBSCRIBE_GENERIC;
}
