import { unauthenticated } from "~/shopify.server";
import { withShopExec } from "~/lib/tenant.server";
import type { BulkFetchResult } from "~/lib/jobs/handlers";
import { logger } from "~/lib/logger.server";
import { FACET_METAFIELD } from "~/lib/search/config";

// Phase 4: capture ONLY the configured facet namespace's metafields (read via
// the existing read_products scope; per-metafield access controls apply —
// REQUIRES VERIFICATION per store). Namespace is server config, never user input.
const METAFIELD_FIELDS = `metafields(namespace: ${JSON.stringify(FACET_METAFIELD.namespace)}, first: 50) {
    edges { node { namespace key value type } }
  }`;

/**
 * Shopify Bulk Operations + single-entity fetch (Admin GraphQL, API 2026-07).
 *
 * Hardening (Phase 2.1):
 *  - Poll the SPECIFIC operation by the id returned from bulkOperationRunQuery
 *    (bulkOperation(id:)) — currentBulkOperation can briefly report an older op.
 *  - A missing result url with objectCount > 0 is an ERROR (incomplete
 *    download), never treated as an empty catalog.
 *  - Includes read_products availability fields (availableForSale,
 *    totalInventory, tracksInventory). Numeric inventoryQuantity is NOT read
 *    (needs read_inventory — see docs/PHASE2.md).
 *  - Phase 3 result-card fields (all read_products, no new scope, verified
 *    2026-09-22): product.onlineStoreUrl (NULL = not published to the Online
 *    Store channel — the publication signal), product.featuredImage {url,altText},
 *    variant.compareAtPrice.
 *
 * Live Admin API + HTTPS calls run against a real store (manual verification);
 * the job pipeline is tested with injected sample data.
 */

const PRODUCT_FIELDS = `
  id title handle description vendor productType status tags updatedAt
  totalInventory tracksInventory
  onlineStoreUrl
  featuredImage { url altText }
  options { name values }
  ${METAFIELD_FIELDS}`;

const VARIANT_FIELDS = `
  id sku barcode title price compareAtPrice position availableForSale updatedAt
  selectedOptions { name value }`;

const PRODUCTS_BULK_QUERY = `{
  products {
    edges { node {
      ${PRODUCT_FIELDS}
      variants { edges { node { ${VARIANT_FIELDS} } } }
      collections { edges { node { id } } }
    } }
  }
}`;

const COLLECTIONS_BULK_QUERY = `{
  collections { edges { node { id title handle description updatedAt } } }
}`;

type AdminClient = { graphql: (query: string, options?: any) => Promise<Response> };

async function gql<T = any>(admin: AdminClient, query: string, variables?: any): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

async function startBulkQuery(admin: AdminClient, query: string): Promise<string> {
  const mutation = `mutation {
    bulkOperationRunQuery(query: ${JSON.stringify(query)}) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;
  const data = await gql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(admin, mutation);
  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (userErrors?.length) throw new Error(`bulkOperationRunQuery: ${userErrors.map((u) => u.message).join("; ")}`);
  if (!bulkOperation) throw new Error("bulkOperationRunQuery returned no operation");
  return bulkOperation.id;
}

interface BulkStatus {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: string | null;
  url: string | null;
}

/** Poll the SPECIFIC operation id (not currentBulkOperation). */
async function pollBulkById(
  admin: AdminClient,
  operationId: string,
  { intervalMs = 2000, timeoutMs = 1000 * 60 * 30 } = {},
): Promise<BulkStatus> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await gql<{ bulkOperation: BulkStatus | null }>(
      admin,
      `{ bulkOperation(id: ${JSON.stringify(operationId)}) { id status errorCode objectCount url } }`,
    );
    const op = data.bulkOperation;
    if (op) {
      if (op.status === "COMPLETED") return op;
      if (op.status === "FAILED" || op.status === "CANCELED") {
        throw new Error(`bulk operation ${op.status}: ${op.errorCode ?? "unknown"}`);
      }
    }
    if (Date.now() > deadline) throw new Error("bulk operation timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Download JSONL. A null url is only valid when objectCount is 0. */
async function downloadJsonl(op: BulkStatus): Promise<string> {
  const objectCount = op.objectCount ? Number(op.objectCount) : 0;
  if (!op.url) {
    if (objectCount > 0) {
      throw new Error(`bulk result has no url but objectCount=${objectCount} (incomplete)`);
    }
    return ""; // genuinely empty result
  }
  const res = await fetch(op.url);
  if (!res.ok) throw new Error(`failed to download bulk JSONL: ${res.status}`);
  return res.text();
}

async function getAdmin(shopId: string): Promise<AdminClient> {
  const shopDomain = await withShopExec(shopId, async (e) => {
    const rows = await e.rows<{ shop_domain: string }>(`SELECT shop_domain FROM shop WHERE id=$1::uuid`, [shopId]);
    if (!rows[0]) throw new Error(`shop ${shopId} not found`);
    return rows[0].shop_domain;
  });
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin as AdminClient;
}

export async function fetchBulkCatalog(shopId: string): Promise<BulkFetchResult> {
  const admin = await getAdmin(shopId);
  // Capture BEFORE any bulk operation begins (G4 reconciliation boundary).
  const snapshotStartedAt = new Date();

  logger.info({ shopId }, "starting product bulk query");
  const productsOpId = await startBulkQuery(admin, PRODUCTS_BULK_QUERY);
  const productsOp = await pollBulkById(admin, productsOpId);
  const productsJsonl = await downloadJsonl(productsOp);

  logger.info({ shopId }, "starting collection bulk query");
  const collectionsOpId = await startBulkQuery(admin, COLLECTIONS_BULK_QUERY);
  const collectionsOp = await pollBulkById(admin, collectionsOpId);
  const collectionsJsonl = await downloadJsonl(collectionsOp);

  return {
    productsJsonl,
    collectionsJsonl,
    // objectCount counts ALL nodes (products+variants+memberships); it is passed
    // only for reference. The true product count is computed from the parsed
    // JSONL in the orchestrator (countProductsInJsonl).
    objectCount: productsOp.objectCount ? Number(productsOp.objectCount) : null,
    snapshotStartedAt,
  };
}

// --- Single-entity re-fetch (incremental path) ---------------------------

const PRODUCT_NODE_QUERY = `query($id: ID!, $vAfter: String, $cAfter: String) {
  product(id: $id) {
    ${PRODUCT_FIELDS}
    variants(first: 250, after: $vAfter) { pageInfo { hasNextPage endCursor } edges { node { ${VARIANT_FIELDS} } } }
    collections(first: 250, after: $cAfter) { pageInfo { hasNextPage endCursor } edges { node { id } } }
  }
}`;

const COLLECTION_NODE_QUERY = `query($id: ID!) {
  collection(id: $id) { id title handle description updatedAt }
}`;

/**
 * Re-fetch a product node by GID, PAGINATING variants and collections fully so
 * a product with >250 variants/memberships is never truncated (G6). The
 * returned node's connections are marked complete so reconcile is allowed.
 * Returns null if the product no longer exists.
 */
export async function fetchProductNode(shopId: string, gid: string): Promise<any | null> {
  const admin = await getAdmin(shopId);
  const first = await gql<{ product: any | null }>(admin, PRODUCT_NODE_QUERY, {
    id: gid, vAfter: null, cAfter: null,
  });
  const node = first.product;
  if (!node) return null;

  // Paginate variants.
  while (node.variants?.pageInfo?.hasNextPage) {
    const more = await gql<{ product: any | null }>(admin, PRODUCT_NODE_QUERY, {
      id: gid, vAfter: node.variants.pageInfo.endCursor, cAfter: null,
    });
    const mv = more.product?.variants;
    if (!mv?.edges?.length) break;
    node.variants.edges.push(...mv.edges);
    node.variants.pageInfo = mv.pageInfo;
  }
  // Paginate collections.
  while (node.collections?.pageInfo?.hasNextPage) {
    const more = await gql<{ product: any | null }>(admin, PRODUCT_NODE_QUERY, {
      id: gid, vAfter: null, cAfter: node.collections.pageInfo.endCursor,
    });
    const mc = more.product?.collections;
    if (!mc?.edges?.length) break;
    node.collections.edges.push(...mc.edges);
    node.collections.pageInfo = mc.pageInfo;
  }
  // Fully loaded now — mark complete so the normalizer allows reconcile.
  if (node.variants?.pageInfo) node.variants.pageInfo.hasNextPage = false;
  if (node.collections?.pageInfo) node.collections.pageInfo.hasNextPage = false;
  return node;
}

export async function fetchCollectionNode(shopId: string, gid: string): Promise<any | null> {
  const admin = await getAdmin(shopId);
  const data = await gql<{ collection: any | null }>(admin, COLLECTION_NODE_QUERY, { id: gid });
  return data.collection ?? null;
}
