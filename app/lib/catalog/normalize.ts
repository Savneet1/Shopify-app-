import type { CollectionInput } from "./store";
import type { NormalizedProduct } from "./bulk-parse";
import { FACET_METAFIELD } from "~/lib/search/config";

/**
 * Canonical normalisation of a Shopify GraphQL Product/Collection NODE into our
 * internal shapes. Used by BOTH the bulk sync path (after reconstructing nested
 * nodes from flattened JSONL) and the incremental webhook path (which re-fetches
 * the entity by GID). Sharing this code removes shape drift between the two
 * paths: identical status casing, plain-text `description`, `selectedOptions`,
 * variant `position`, and collection memberships.
 *
 * Accepts either connection form: `{ edges: [{ node }] }` or `{ nodes: [] }`,
 * or a plain array.
 */
function connectionNodes(c: any): any[] {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.nodes)) return c.nodes;
  if (Array.isArray(c.edges)) return c.edges.map((e: any) => e?.node).filter(Boolean);
  return [];
}

/** false only when a connection reports pageInfo.hasNextPage (truncated). */
function connectionComplete(c: any): boolean {
  return !(c && c.pageInfo && c.pageInfo.hasNextPage === true);
}

function toTags(tags: any): string[] {
  if (Array.isArray(tags)) return tags.map((t) => String(t));
  if (typeof tags === "string") return tags.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * Flatten the captured metafields (configured namespace only) into a
 * { "namespace.key": "value" } map. Only scalar string values are kept — the
 * Phase 4 facet is single-value exact-match; richer metafield types
 * (list/number/date/money/boolean) are out of scope (docs/PHASE4.md).
 */
function toMetafields(node: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of connectionNodes(node.metafields)) {
    if (!m || m.namespace == null || m.key == null || m.value == null) continue;
    if (m.namespace !== FACET_METAFIELD.namespace) continue;
    const v = String(m.value);
    // Keep only simple scalar values (skip JSON-array/object list types).
    if (v.startsWith("[") || v.startsWith("{")) continue;
    out[`${m.namespace}.${m.key}`] = v;
  }
  return out;
}

export function normalizeProductNode(node: any): NormalizedProduct {
  const variants = connectionNodes(node.variants).map((v: any) => ({
    shopifyVariantGid: v.id,
    sku: v.sku ?? null,
    barcode: v.barcode ?? null,
    title: v.title ?? null,
    price: v.price ?? null,
    compareAtPrice: v.compareAtPrice ?? null,
    position: typeof v.position === "number" ? v.position : null,
    selectedOptions: Array.isArray(v.selectedOptions) ? v.selectedOptions : [],
    availableForSale:
      typeof v.availableForSale === "boolean" ? v.availableForSale : null,
    shopifyUpdatedAt: v.updatedAt ?? null,
  }));
  const collectionGids = connectionNodes(node.collections)
    .map((c: any) => c.id)
    .filter(Boolean);

  return {
    product: {
      shopifyProductGid: node.id,
      handle: node.handle ?? null,
      title: node.title ?? null,
      // Always plain-text `description` (never body_html) so both paths match.
      description: node.description ?? null,
      vendor: node.vendor ?? null,
      productType: node.productType ?? null,
      status: node.status ?? null,
      tags: toTags(node.tags),
      options: Array.isArray(node.options) ? node.options : [],
      totalInventory:
        typeof node.totalInventory === "number" ? node.totalInventory : null,
      tracksInventory:
        typeof node.tracksInventory === "boolean" ? node.tracksInventory : null,
      // Phase 3 result-card / publication fields.
      featuredImageUrl: node.featuredImage?.url ?? null,
      featuredImageAlt: node.featuredImage?.altText ?? null,
      // onlineStoreUrl is null when NOT published to the Online Store channel;
      // storefront search uses it as the publication signal.
      onlineStoreUrl: node.onlineStoreUrl ?? null,
      // Phase 4: configured-namespace metafields for the facet.
      metafields: toMetafields(node),
      // Phase 6: Shopify creation timestamp for the "newest" sort hint.
      productCreatedAt: node.createdAt ?? null,
      shopifyUpdatedAt: node.updatedAt ?? null,
    },
    variants,
    collectionGids,
    variantsComplete: connectionComplete(node.variants),
    collectionsComplete: connectionComplete(node.collections),
  };
}

export function normalizeCollectionNode(node: any): CollectionInput {
  return {
    shopifyCollectionGid: node.id,
    handle: node.handle ?? null,
    title: node.title ?? null,
    description: node.description ?? null,
    shopifyUpdatedAt: node.updatedAt ?? null,
  };
}
