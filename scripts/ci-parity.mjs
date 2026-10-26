#!/usr/bin/env node
/*
 * Phase 12.2 R3 — run the FULL test suite the way CI (live-prisma-check.yml)
 * does, so a test can never silently depend on a developer's gitignored .env
 * (the Phase 12 CI failure). It:
 *   - reads the `env:` block from .github/workflows/live-prisma-check.yml (the
 *     single source of truth, so the parity env and CI cannot drift);
 *   - spawns `vitest run` in a SCRUBBED environment containing ONLY those
 *     variables (plus the bare essentials a Node process needs: PATH/HOME/…),
 *     with CI_PARITY=1 so the test setup does NOT load .env;
 *   - the four *DATABASE_URL vars are mapped to the LOCAL instance (DB location
 *     is infra, not app config) so the suite can actually connect here; every
 *     APP secret — above all EMAIL_ENCRYPTION_KEY — comes ONLY from the workflow
 *     block, never from .env.
 *
 * `parseWorkflowEnv` is exported so a vitest drift-guard test can assert the
 * workflow still provides the keys the app needs.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "live-prisma-check.yml");

/**
 * Parse the JOB-level `env:` block — the one that defines the app env (it
 * contains DATABASE_URL). The file also has a `services.postgres.env:` block
 * (POSTGRES_USER/…), which we must NOT return, so we scan every `env:` block and
 * pick the one defining DATABASE_URL.
 */
export function parseWorkflowEnv(file = WORKFLOW) {
  const lines = readFileSync(file, "utf8").split("\n");
  const blocks = [];
  let cur = null;
  let envIndent = -1;
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    if (/^\s*env:\s*$/.test(raw)) { cur = {}; blocks.push(cur); envIndent = indent; continue; }
    if (cur) {
      if (indent <= envIndent) { cur = null; continue; } // dedent → block ended
      const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
      if (m) {
        let v = m[2].replace(/\s+#.*$/, ""); // strip trailing inline comment
        v = v.replace(/^["']|["']$/g, "");   // strip surrounding quotes
        cur[m[1]] = v;
      }
    }
  }
  return blocks.find((b) => "DATABASE_URL" in b) ?? {};
}

/** Read the four local *DATABASE_URL values from .env (infra override). */
function localDbUrls() {
  const out = {};
  try {
    const env = readFileSync(join(ROOT, ".env"), "utf8");
    for (const key of ["DATABASE_URL", "DIRECT_DATABASE_URL", "TEST_DATABASE_URL", "TEST_DIRECT_DATABASE_URL"]) {
      const m = env.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"));
      if (m) out[key] = m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env (e.g. real CI) → keep the workflow values */ }
  return out;
}

function main() {
  const workflowEnv = parseWorkflowEnv();
  const dbOverride = localDbUrls();
  // env -i style: only PATH/HOME/essentials + the workflow vars; NO ambient
  // app vars from the developer's shell/.env.
  const base = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  const childEnv = {
    ...base,
    ...workflowEnv,
    ...dbOverride,       // DB location is infra; point at the local instance
    CI_PARITY: "1",      // test setup must NOT load .env
    NODE_ENV: "test",
  };
  const varNames = Object.keys(workflowEnv).sort().join(", ");
  console.log(`[ci-parity] workflow env vars: ${varNames}`);
  console.log(`[ci-parity] EMAIL_ENCRYPTION_KEY from workflow: ${workflowEnv.EMAIL_ENCRYPTION_KEY ? "present" : "ABSENT"}`);
  const res = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], {
    cwd: ROOT, env: childEnv, stdio: "inherit",
  });
  process.exit(res.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
