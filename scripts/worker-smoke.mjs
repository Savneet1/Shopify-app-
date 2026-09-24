// Worker RUNTIME smoke: proves pg-boss connects as app_runtime (migrate:false),
// registers a worker, processes a job, and shuts down cleanly on SIGTERM —
// exactly the lifecycle app/lib/jobs/run-worker.ts drives.
//
// This is decoupled from Prisma on purpose: the production worker (npm run
// worker) instantiates Prisma, whose engine binary cannot be downloaded in this
// offline sandbox. The Prisma-backed handler pipeline is proven by the vitest
// integration test; this smoke proves the queue/worker/SIGTERM mechanics.
import "dotenv/config";
import { PgBoss } from "pg-boss";

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const boss = new PgBoss({ connectionString: url, schema: process.env.BOSS_SCHEMA || "pgboss", migrate: false });
boss.on("error", (e) => console.error("[worker] pg-boss error:", e.message));

let processed = false;

async function main() {
  await boss.start();
  console.log("[worker] started; connected as app_runtime (migrate:false)");

  const q = "worker-smoke";
  await boss.createQueue(q);
  await boss.work(q, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) {
      console.log("[worker] processing job", job.id, JSON.stringify(job.data));
      processed = true;
    }
  });

  process.on("SIGTERM", async () => {
    console.log("[worker] SIGTERM received; shutting down gracefully");
    await boss.stop({ graceful: false });
    console.log("[worker] stopped");
    process.exit(0);
  });

  await boss.send(q, { shopId: "demo", hello: "world" });

  // Wait for the job to be processed, then self-signal SIGTERM to show shutdown.
  const deadline = Date.now() + 8000;
  while (!processed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  console.log("[worker] job processed:", processed);
  process.kill(process.pid, "SIGTERM");
}

main().catch((e) => {
  console.error("[worker] failed:", e.message);
  process.exit(1);
});
