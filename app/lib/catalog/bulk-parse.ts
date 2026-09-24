import type { CollectionInput } from "./store";
import {
  normalizeProductNode,
  normalizeCollectionNode,
} from "./normalize";
import type { ProductInput, VariantInput } from "./store";

/**
 * Parse Shopify Bulk Operation JSONL results. Bulk flattens nested connections
 * with `__parentId`; we regroup ProductVariant + Collection lines under their
 * parent Product into a nested node, then run the SAME normalizer used by the
 * incremental (re-fetch) path — so both paths produce identical records.
 */

export interface NormalizedProduct {
  product: ProductInput;
  variants: VariantInput[];
  collectionGids: string[];
  // false when the source connection was truncated (pageInfo.hasNextPage) — the
  // caller must NOT reconcile (delete) variants/memberships from a partial view.
  variantsComplete?: boolean;
  collectionsComplete?: boolean;
}

export function parseGidType(gid: string): string | null {
  const m = /^gid:\/\/shopify\/([^/]+)\//.exec(gid);
  return m ? m[1] : null;
}

function parseLines(jsonl: string): any[] {
  const out: any[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

export function parseProductsJsonl(jsonl: string): NormalizedProduct[] {
  const objs = parseLines(jsonl);
  const nodes = new Map<string, any>();

  // Pass 1: product nodes.
  for (const o of objs) {
    if (o?.id && parseGidType(o.id) === "Product" && o.__parentId == null) {
      nodes.set(o.id, { ...o, variants: { nodes: [] }, collections: { nodes: [] } });
    }
  }
  // Pass 2: attach children.
  for (const o of objs) {
    if (!o?.id || o.__parentId == null) continue;
    const parent = nodes.get(o.__parentId);
    if (!parent) continue;
    const type = parseGidType(o.id);
    if (type === "ProductVariant") parent.variants.nodes.push(o);
    else if (type === "Collection") parent.collections.nodes.push({ id: o.id });
  }

  return [...nodes.values()].map(normalizeProductNode);
}

export function parseCollectionsJsonl(jsonl: string): CollectionInput[] {
  return parseLines(jsonl)
    .filter((o) => o?.id && o.__parentId == null && parseGidType(o.id) === "Collection")
    .map(normalizeCollectionNode);
}

/** True product count from a parsed products JSONL (not objectCount, which
 * counts all nodes incl. variants + membership refs). */
export function countProductsInJsonl(jsonl: string): number {
  let n = 0;
  for (const o of parseLines(jsonl)) {
    if (o?.id && o.__parentId == null && parseGidType(o.id) === "Product") n++;
  }
  return n;
}
