/**
 * Phase 11.6 — attribution (what is possible WITHOUT new scopes). Pure,
 * deterministic, last-click, within a single consented session. Links a
 * search → a click → an add_to_cart_from_search when they occur in the same
 * session within a configurable inactivity window. PURCHASE/REVENUE attribution
 * is NOT implemented (no order data, no scopes). The unwired customer-events
 * MAPPING lives in ./customer-events.ts.
 */

export const DEFAULT_SESSION_WINDOW_MIN = 30;

export interface SessionEvent {
  sessionId: string | null;
  eventType: string;
  occurredAt: Date;
  queryNorm: string | null;
  productGid: string | null;
}

export interface Attribution {
  sessionId: string;
  query: string | null;
  productGid: string;
  clickAt: Date;
  addToCartAt: Date;
}

const CLICK_TYPES = new Set(["result_click", "predictive_click", "suggestion_click", "recommendation_click"]);

/**
 * attributeAddToCarts: for each add_to_cart_from_search, find the most recent
 * preceding click (any surface) of the SAME product in the SAME session within
 * `windowMin` minutes — last-click attribution. Events with no session id are
 * ignored (anonymous mode cannot attribute). Deterministic: input order does
 * not matter (events are sorted by time, ties broken by a stable key).
 */
export function attributeAddToCarts(
  events: SessionEvent[], windowMin = DEFAULT_SESSION_WINDOW_MIN,
): Attribution[] {
  const windowMs = Math.max(1, Math.floor(windowMin)) * 60_000;
  const sessions = new Map<string, SessionEvent[]>();
  for (const e of events) {
    if (!e.sessionId) continue;
    const arr = sessions.get(e.sessionId) ?? [];
    arr.push(e);
    sessions.set(e.sessionId, arr);
  }
  const out: Attribution[] = [];
  for (const [sessionId, evs] of sessions) {
    evs.sort((a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      a.eventType.localeCompare(b.eventType) ||
      (a.productGid ?? "").localeCompare(b.productGid ?? ""));
    // last click per product, with the query that preceded it
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.eventType !== "add_to_cart_from_search" || !e.productGid) continue;
      let best: SessionEvent | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const c = evs[j];
        if (c.occurredAt.getTime() < e.occurredAt.getTime() - windowMs) break; // out of window
        if (CLICK_TYPES.has(c.eventType) && c.productGid === e.productGid) { best = c; break; }
      }
      if (best) {
        out.push({ sessionId, query: best.queryNorm, productGid: e.productGid, clickAt: best.occurredAt, addToCartAt: e.occurredAt });
      }
    }
  }
  out.sort((a, b) => a.addToCartAt.getTime() - b.addToCartAt.getTime() || a.sessionId.localeCompare(b.sessionId));
  return out;
}
