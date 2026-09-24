import type { IncrementalPayload } from "~/lib/jobs/queue";

/**
 * Map a Shopify catalog webhook to an "entity changed" incremental job. We do
 * NOT trust the webhook body's fields — the worker re-fetches the entity by GID
 * (same normalization as the bulk path). So product/collection create, update,
 * AND delete all map to a re-fetch job (a delete is detected when the re-fetch
 * returns null). dedupeKey = topic:webhookId collapses duplicate deliveries.
 */

const productGid = (id: string | number) => `gid://shopify/Product/${id}`;
const collectionGid = (id: string | number) => `gid://shopify/Collection/${id}`;

export function mapCatalogWebhook(
  topic: string,
  payload: any,
  shopId: string,
  webhookId: string,
): IncrementalPayload | null {
  const t = topic.toUpperCase().replace(/\//g, "_");
  const dedupeKey = `${t}:${webhookId}`;
  if (t.startsWith("PRODUCTS_")) {
    if (payload?.id == null) return null;
    return { shopId, dedupeKey, entity: "product", gid: productGid(payload.id) };
  }
  if (t.startsWith("COLLECTIONS_")) {
    if (payload?.id == null) return null;
    return { shopId, dedupeKey, entity: "collection", gid: collectionGid(payload.id) };
  }
  return null;
}
