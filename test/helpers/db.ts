import pg from "pg";
import type { Exec } from "~/lib/db/executor";

/** pg-backed Exec (mirrors the production Prisma-backed Exec used under withShop). */
export function pgExec(client: pg.PoolClient): Exec {
  return {
    rows: async <T>(sql: string, params: unknown[] = []) =>
      (await client.query(sql, params as unknown[])).rows as T[],
    run: async (sql: string, params: unknown[] = []) =>
      (await client.query(sql, params as unknown[])).rowCount ?? 0,
  };
}

/**
 * Per-test-file database harness. Uses node-postgres directly so the tests run
 * even where the Prisma engine binary is unavailable (offline sandbox). The SQL
 * exercised here (SET LOCAL app.shop_id, app_resolve_shop, the webhook claim,
 * RLS policies) is the IDENTICAL SQL the production Prisma layer issues — see
 * app/lib/sql.server.ts and prisma/migrations/0002_rls_roles.
 *
 *  - runtimePool -> app_runtime role (NOSUPERUSER, NOBYPASSRLS) => RLS applies.
 *  - ownerPool   -> app_owner role (migrations/teardown only).
 */
export interface TestDb {
  runtimePool: pg.Pool;
  ownerPool: pg.Pool;
  resetDb: () => Promise<void>;
  resolveShop: (domain: string) => Promise<string>;
  withShopClient: <T>(
    shopId: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ) => Promise<T>;
  withShopExec: <T>(shopId: string, fn: (exec: Exec) => Promise<T>) => Promise<T>;
  /** Non-tenant Exec over the runtime pool (for SECURITY DEFINER function calls). */
  rootExec: Exec;
  close: () => Promise<void>;
}

export function makeDb(): TestDb {
  const runtimeUrl = requireEnv("TEST_DATABASE_URL");
  const ownerUrl = requireEnv("TEST_DIRECT_DATABASE_URL");

  const runtimePool = new pg.Pool({ connectionString: runtimeUrl, max: 4 });
  const ownerPool = new pg.Pool({ connectionString: ownerUrl, max: 2 });

  async function resetDb() {
    await ownerPool.query("TRUNCATE shop CASCADE");
    await ownerPool.query("TRUNCATE session CASCADE");
  }

  async function resolveShop(domain: string): Promise<string> {
    const { rows } = await runtimePool.query<{ id: string }>(
      "SELECT app_resolve_shop($1) AS id",
      [domain],
    );
    return rows[0].id;
  }

  async function withShopClient<T>(
    shopId: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.shop_id', $1, true)", [shopId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async function withShopExec<T>(
    shopId: string,
    fn: (exec: Exec) => Promise<T>,
  ): Promise<T> {
    return withShopClient(shopId, (client) => fn(pgExec(client)));
  }

  async function close() {
    await runtimePool.end();
    await ownerPool.end();
  }

  const rootExec: Exec = {
    rows: async <T>(sql: string, params: unknown[] = []) =>
      (await runtimePool.query(sql, params as unknown[])).rows as T[],
    run: async (sql: string, params: unknown[] = []) =>
      (await runtimePool.query(sql, params as unknown[])).rowCount ?? 0,
  };

  return {
    runtimePool,
    ownerPool,
    resetDb,
    resolveShop,
    withShopClient,
    withShopExec,
    rootExec,
    close,
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name} for DB tests`);
  return v;
}
