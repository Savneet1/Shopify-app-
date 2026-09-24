import { getPrisma } from "~/db.server";
import type { Exec } from "./executor";

/**
 * A NON-tenant executor (no withShop / no app.shop_id). Used ONLY for the
 * scheduled reconciliation enumeration, which calls the SECURITY DEFINER
 * function app_shops_needing_full_sync() to list shop ids across tenants. It
 * must never be used for tenant data reads/writes — those always go through
 * withShop (RLS-bound).
 */
export function prismaRootExec(): Exec {
  const p = getPrisma();
  return {
    rows: <T>(sql: string, params: unknown[] = []) =>
      p.$queryRawUnsafe(sql, ...params) as Promise<T[]>,
    run: async (sql: string, params: unknown[] = []) =>
      (await p.$executeRawUnsafe(sql, ...params)) as number,
  };
}
