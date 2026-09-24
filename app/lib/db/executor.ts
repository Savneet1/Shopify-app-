import type { TenantTx } from "~/lib/tenant.server";

/**
 * Minimal SQL executor. The catalog/index/sync logic is written against this
 * interface so the SAME code + SAME SQL runs in production (Prisma-backed, under
 * withShop) and in tests (node-postgres, under an equivalent tenant tx). This
 * avoids any drift between shipped and tested behaviour.
 */
export interface Exec {
  /** Run a statement that returns rows (SELECT, or DML with RETURNING). */
  rows<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a statement that returns no rows; resolves to affected row count. */
  run(sql: string, params?: unknown[]): Promise<number>;
}

/** Prisma-backed executor bound to a tenant transaction (app.shop_id set). */
export function prismaExec(tx: TenantTx): Exec {
  return {
    rows: <T>(sql: string, params: unknown[] = []) =>
      tx.$queryRawUnsafe(sql, ...params) as Promise<T[]>,
    run: async (sql: string, params: unknown[] = []) =>
      (await tx.$executeRawUnsafe(sql, ...params)) as number,
  };
}
