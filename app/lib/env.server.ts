import { z } from "zod";

/**
 * Validated server environment. Fail fast at boot if required config is missing.
 * NOTE: only imported by server entrypoints (never by the browser bundle).
 */
const EnvSchema = z.object({
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_APP_URL: z.string().url(),
  // Phase 1: empty string is valid and expected (no access scopes).
  SCOPES: z.string().default(""),
  DATABASE_URL: z.string().min(1),
  // Owner connection — migrations / pg-boss schema install only. Never used by
  // runtime request/worker code (Phase 14e removed the last such use).
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  // Phase 14e — least-privilege maintenance connection (app_maintenance) used
  // ONLY by the post-build / self-heal ANALYZE. Optional: when unset the ANALYZE
  // path no-ops and autovacuum (reloptions 0020/0026) is the fallback.
  MAINTENANCE_DATABASE_URL: z.string().min(1).optional(),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (!cached) {
    cached = EnvSchema.parse(process.env);
  }
  return cached;
}
