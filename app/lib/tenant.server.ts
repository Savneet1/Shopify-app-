import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { getPrisma } from "~/db.server";
import { RESOLVE_SHOP_SQL, SET_LOCAL_SHOP_SQL } from "~/lib/sql.server";
import { prismaExec, type Exec } from "~/lib/db/executor";

/**
 * A myshopify.com domain is the ONLY accepted form of tenant identity. This
 * value must always come from a server-verified Shopify session — never from a
 * query string, request body, or arbitrary header.
 */
export const ShopDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/,
    "must be a valid <name>.myshopify.com domain",
  );

export function assertShopDomain(domain: unknown): string {
  return ShopDomainSchema.parse(domain);
}

/**
 * Resolve the internal shop.id (UUID) for an authenticated shop domain.
 * Uses the SECURITY DEFINER bootstrap function; safe to call before any
 * tenant context is set. NEVER pass client-supplied input here.
 */
export async function resolveShopId(shopDomain: string): Promise<string> {
  const domain = assertShopDomain(shopDomain);
  const rows = (await getPrisma().$queryRawUnsafe(
    RESOLVE_SHOP_SQL,
    domain,
  )) as Array<{ id: string }>;
  if (!rows[0]?.id) {
    throw new Error(`Unable to resolve shop id for ${domain}`);
  }
  return rows[0].id;
}

export type TenantTx = Prisma.TransactionClient;

/**
 * Run `fn` inside a transaction with the tenant context bound via
 * `SET LOCAL app.shop_id`. All queries issued through the provided `tx` are
 * then constrained by Row-Level Security to this shop.
 *
 * `shopId` MUST be an internal UUID obtained from resolveShopId() (i.e. derived
 * from a verified session), never a client-provided value.
 */
export async function withShop<T>(
  shopId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!shopId) {
    throw new Error("withShop requires a shopId");
  }
  return getPrisma().$transaction(
    async (tx: TenantTx) => {
      // set_config(name, value, is_local=true) === SET LOCAL: scoped to this tx.
      await tx.$executeRawUnsafe(SET_LOCAL_SHOP_SQL, shopId);
      return fn(tx);
    },
    {
      // Prisma interactive transactions default to a 5s timeout, too short for a
      // sync chunk. Full sync is chunked (SYNC_CHUNK_SIZE) so these bounds hold.
      maxWait: Number(process.env.TX_MAX_WAIT_MS || 10000),
      timeout: Number(process.env.TX_TIMEOUT_MS || 120000),
    },
  );
}

/**
 * Convenience: resolve a shop domain to its id and immediately run within its
 * tenant context.
 */
export async function withShopDomain<T>(
  shopDomain: string,
  fn: (tx: TenantTx, shopId: string) => Promise<T>,
): Promise<T> {
  const shopId = await resolveShopId(shopDomain);
  return withShop(shopId, (tx) => fn(tx, shopId));
}

/**
 * Run `fn` inside the tenant context with an {@link Exec} bound to it. Preferred
 * entry point for the Phase 2 catalog/index/sync logic.
 */
export async function withShopExec<T>(
  shopId: string,
  fn: (exec: Exec) => Promise<T>,
): Promise<T> {
  return withShop(shopId, (tx) => fn(prismaExec(tx)));
}
