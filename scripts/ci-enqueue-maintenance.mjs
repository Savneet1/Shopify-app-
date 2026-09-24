// CI helper: enqueue ONE maintenance-reconcile job so the running worker
// processes a real job through the real Prisma path. On a fresh CI database the
// shop table is empty, so runReconciliationTick finds no shops needing a full
// sync and completes cleanly (enqueued: 0) — no Shopify Admin API call is made,
// so the job succeeds deterministically without any external dependency.
//
// Used only by .github/workflows/live-prisma-check.yml. The queue itself is
// created by the worker's startQueues(); we only send to it here.
import "dotenv/config";
import { PgBoss } from "pg-boss";

const connectionString = process.env.BOSS_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[ci] DATABASE_URL is required to enqueue");
  process.exit(1);
}

const boss = new PgBoss({
  connectionString,
  schema: process.env.BOSS_SCHEMA || "pgboss",
  migrate: false, // schema already installed by the operator (pgboss:install)
});
boss.on("error", (e) => console.error("[ci] pg-boss error:", e.message));

try {
  await boss.start();
  const id = await boss.send("maintenance-reconcile", {});
  console.log(`[ci] enqueued maintenance-reconcile job id=${id}`);
  await boss.stop({ graceful: false });
  process.exit(0);
} catch (e) {
  console.error("[ci] enqueue failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
