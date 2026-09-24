// One-time pg-boss schema install/upgrade, run by an OPERATOR as app_owner.
// The app + worker then run as app_runtime with migrate:false (least privilege;
// no CREATE ON DATABASE). Re-run this after upgrading pg-boss.
//
//   npm run pgboss:install
//
// Uses BOSS_MIGRATE_URL or DIRECT_DATABASE_URL (the app_owner connection) and
// BOSS_SCHEMA (default "pgboss").
import "dotenv/config";
import { PgBoss } from "pg-boss";

const connectionString = process.env.BOSS_MIGRATE_URL || process.env.DIRECT_DATABASE_URL;
const schema = process.env.BOSS_SCHEMA || "pgboss";
if (!connectionString) {
  console.error("Set DIRECT_DATABASE_URL (app_owner) or BOSS_MIGRATE_URL");
  process.exit(1);
}

const boss = new PgBoss({ connectionString, schema });
boss.on("error", (e) => console.error("pg-boss:", e.message));
try {
  await boss.start(); // installs/migrates the schema as owner
  await boss.stop({ graceful: false });
  console.log(`pg-boss schema installed/migrated in "${schema}"`);
  process.exit(0);
} catch (e) {
  console.error("pg-boss install failed:", e.message);
  process.exit(1);
}
