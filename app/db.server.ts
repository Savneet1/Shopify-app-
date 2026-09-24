import { PrismaClient } from "@prisma/client";

/**
 * Lazily-initialised Prisma singleton.
 *
 * The client connects as DATABASE_URL, which MUST be the `app_runtime` role
 * (NOSUPERUSER, NOBYPASSRLS). Every tenant query therefore runs under
 * Row-Level Security. Migrations use DIRECT_DATABASE_URL (`app_owner`).
 *
 * Initialisation is lazy so that importing this module does not construct a
 * client (keeps unit tests that mock this module engine-free).
 */
declare global {
  // eslint-disable-next-line no-var
  var __prisma__: PrismaClient | undefined;
}

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (client) return client;
  // Reuse across HMR in dev to avoid exhausting connections.
  if (global.__prisma__) {
    client = global.__prisma__;
    return client;
  }
  client = new PrismaClient();
  if (process.env.NODE_ENV !== "production") {
    global.__prisma__ = client;
  }
  return client;
}

export type { PrismaClient };
