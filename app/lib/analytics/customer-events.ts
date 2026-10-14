import type { CleanEvent, EventType, Surface } from "./events";

/**
 * Phase 11.6 — UNWIRED mapping from Shopify standard customer events (the ones a
 * Web Pixel would deliver) to our analytics_event schema. This module is pure
 * and fully tested, but it is NOT wired to anything: delivering these events
 * needs a Shopify **Web Pixel extension** plus the `write_pixels` and
 * `read_customer_events` scopes — none of which are approved. See docs/PHASE11.md.
 *
 * Supported standard events (subset): `search_submitted`, `product_added_to_cart`,
 * `checkout_completed`. Only search → add-to-cart signals map to our existing
 * first-party event types; `checkout_completed` maps to NOTHING here (purchase /
 * revenue attribution is explicitly out of scope — it would need order data).
 */

export interface StandardCustomerEvent {
  name: string;
  // Shopify's customer-event payloads nest data under `data`; we read defensively.
  data?: Record<string, unknown>;
  clientId?: unknown; // Web Pixel clientId — we would NOT persist it as-is (see docs)
}

/** What a mapped event looks like before validateEvent (so it reuses the same
 * validation + redaction pipeline). Deliberately the storefront-facing shape. */
export interface MappedRawEvent {
  eventType: EventType;
  surface: Surface;
  query?: string;
  productGid?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Map one standard customer event to our raw event shape, or null when it has
 * no first-party analogue (incl. checkout_completed → null, by design). Pure.
 */
export function mapCustomerEvent(ev: StandardCustomerEvent): MappedRawEvent | null {
  if (!ev || typeof ev.name !== "string") return null;
  const d = (ev.data ?? {}) as Record<string, any>;
  switch (ev.name) {
    case "search_submitted": {
      const q = str(d?.searchResult?.query) ?? str(d?.query);
      return { eventType: "search_performed", surface: "search_page", query: q };
    }
    case "product_added_to_cart": {
      // Shopify exposes the variant's product id; we would only keep it as a
      // Product GID when present and well-formed (validateEvent re-checks).
      const pid = str(d?.cartLine?.merchandise?.product?.id) ?? str(d?.productVariant?.product?.id);
      const gid = pid && /^gid:\/\/shopify\/Product\/\d{1,20}$/.test(pid) ? pid : undefined;
      return { eventType: "add_to_cart_from_search", surface: "search_page", productGid: gid };
    }
    case "checkout_completed":
      // Purchase/revenue attribution is NOT implemented (needs order data /
      // scopes). Intentionally unmapped.
      return null;
    default:
      return null;
  }
}

/** Map a list; drop unmappable events. Pure. */
export function mapCustomerEvents(list: StandardCustomerEvent[]): MappedRawEvent[] {
  const out: MappedRawEvent[] = [];
  for (const ev of list) {
    const m = mapCustomerEvent(ev);
    if (m) out.push(m);
  }
  return out;
}

// Referenced for typing only; keeps the CleanEvent import meaningful for
// downstream consumers that re-validate a MappedRawEvent.
export type { CleanEvent };
