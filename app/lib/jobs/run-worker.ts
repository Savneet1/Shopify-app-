/**
 * Background worker entrypoint. Run as a SEPARATE process from the web app:
 *
 *   NODE_ENV=production node ./build/worker/run-worker.js   (after bundling)
 *
 * or with a TypeScript runner in development. It requires the same env as the
 * app (DATABASE_URL = app_runtime, SHOPIFY_API_KEY/SECRET/APP_URL for the
 * Admin API calls made during full sync). See docs/PHASE2.md "Worker setup".
 */
// Load .env in dev if dotenv is present; in production (`npm ci --omit=dev`)
// dotenv is absent and env comes from the environment — the import fails
// gracefully. (`node --env-file=.env` also works and needs no dependency.)
try {
  // @ts-expect-error optional dev-only dependency; absent under `npm ci --omit=dev`
  await import("dotenv/config");
} catch {
  /* no dotenv at runtime — env provided by the environment */
}
import { startWorker } from "./worker";
import { stopQueues } from "./queue";
import { logger } from "~/lib/logger.server";

async function main() {
  await startWorker();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down");
    await stopQueues().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "worker failed to start");
  process.exit(1);
});
