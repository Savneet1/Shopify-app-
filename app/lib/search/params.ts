import type { RawFilters } from "./filters";

/**
 * Parse filter params from a URLSearchParams into RawFilters (Phase 4).
 *
 * Multi-value groups accept BOTH repeated params (?tags=a&tags=b) and a single
 * comma-separated value (?tags=a,b). Everything is passed through to
 * normalizeFilters, which validates, caps and binds it — this function does no
 * trust-granting of its own.
 */
export function filtersFromSearchParams(sp: URLSearchParams): RawFilters {
  const multi = (key: string): string[] => {
    const all = sp.getAll(key);
    const flat: string[] = [];
    for (const v of all) for (const part of v.split(",")) flat.push(part);
    return flat.map((s) => s.trim()).filter((s) => s.length > 0);
  };
  const single = (key: string): string | undefined => {
    const v = sp.get(key);
    return v == null || v.trim() === "" ? undefined : v.trim();
  };
  return {
    vendor: multi("vendor"),
    productType: multi("productType"),
    tags: multi("tags"),
    metafield: multi("metafield"),
    priceMin: single("priceMin") ?? null,
    priceMax: single("priceMax") ?? null,
    available: single("available") ?? null,
    collectionId: single("collectionId") ?? null,
  };
}
