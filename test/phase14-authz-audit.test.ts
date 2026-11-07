import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase 14.4c — AUTHORIZATION AUDIT. Enumerate EVERY route in app/routes.ts and
 * assert the correct guard is present in each route module:
 *   - admin routes (under "app")      → authenticate.admin
 *   - App Proxy routes ("proxy/*")    → handleProxy (signature-verified shop)
 *   - webhook routes ("webhooks/*")   → authenticate.webhook (HMAC)
 * Everything else must be on an EXPLICIT allowlist with a stated reason, so a
 * new unguarded route can never slip in unnoticed. Mutation-tested (removing a
 * guard fails this test).
 */

const ROOT = join(__dirname, "..");
const routesSrc = readFileSync(join(ROOT, "app", "routes.ts"), "utf8");

/** Every "routes/<file>" referenced in the route table, with its URL path. */
function routeTable(): { path: string; file: string }[] {
  const out: { path: string; file: string }[] = [];
  // index("routes/x.tsx")  and  route("path", "routes/x.tsx")
  const idx = routesSrc.matchAll(/index\(\s*"(routes\/[^"]+)"/g);
  for (const m of idx) out.push({ path: "index", file: m[1] });
  const rt = routesSrc.matchAll(/route\(\s*"([^"]+)"\s*,\s*"(routes\/[^"]+)"/g);
  for (const m of rt) out.push({ path: m[1], file: m[2] });
  return out;
}

// Routes that are intentionally NOT admin/proxy/webhook-guarded, each with why.
const ALLOWLIST: Record<string, string> = {
  "routes/_index.tsx": "public landing/redirect; no tenant data",
  "routes/auth.$.tsx": "the auth/token-exchange handler itself",
  "routes/app.tsx": "embedded layout; children authenticate; it calls authenticate.admin",
  "routes/restock.confirm.tsx": "public double-opt-in confirm from email; constant-time token check, no login",
  "routes/restock.unsubscribe.tsx": "public unsubscribe from email; token check, no login",
  "routes/healthz.tsx": "liveness probe; DB connectivity only, no auth, no tenant data",
};

// Classify by MODULE FILE name (robust to nested child paths like "sync" that
// carry no "app/" prefix): the admin surface lives in routes/app.*.tsx, proxy in
// routes/proxy.*.tsx, webhooks in routes/webhooks.*.tsx.
function classify(file: string): "admin" | "proxy" | "webhook" | "other" {
  if (file === "routes/app.tsx") return "other"; // the layout (allowlisted)
  if (file.startsWith("routes/app.")) return "admin";
  if (file.startsWith("routes/proxy.")) return "proxy";
  if (file.startsWith("routes/webhooks.")) return "webhook";
  return "other";
}

describe("Phase 14.4c — authorization audit", () => {
  const table = routeTable();

  it("finds the full route table", () => {
    expect(table.length).toBeGreaterThanOrEqual(30);
  });

  it("every admin route calls authenticate.admin", () => {
    const offenders: string[] = [];
    for (const r of table) {
      if (classify(r.file) !== "admin") continue;
      if (r.file === "routes/app.tsx") continue; // layout (allowlisted)
      const src = readFileSync(join(ROOT, "app", r.file), "utf8");
      if (!src.includes("authenticate.admin")) offenders.push(r.file);
    }
    expect(offenders, `admin routes missing authenticate.admin: ${offenders.join(", ")}`).toEqual([]);
  });

  it("every proxy route uses handleProxy", () => {
    const offenders: string[] = [];
    for (const r of table) {
      if (classify(r.file) !== "proxy") continue;
      const src = readFileSync(join(ROOT, "app", r.file), "utf8");
      if (!src.includes("handleProxy")) offenders.push(r.file);
    }
    expect(offenders, `proxy routes missing handleProxy: ${offenders.join(", ")}`).toEqual([]);
  });

  it("every webhook route verifies HMAC via authenticate.webhook", () => {
    const offenders: string[] = [];
    for (const r of table) {
      if (classify(r.file) !== "webhook") continue;
      const src = readFileSync(join(ROOT, "app", r.file), "utf8");
      if (!src.includes("authenticate.webhook")) offenders.push(r.file);
    }
    expect(offenders, `webhook routes missing authenticate.webhook: ${offenders.join(", ")}`).toEqual([]);
  });

  it("every 'other' (unguarded) route is on the explicit allowlist", () => {
    const unexpected: string[] = [];
    for (const r of table) {
      if (classify(r.file) !== "other") continue;
      if (!(r.file in ALLOWLIST)) unexpected.push(`${r.path} → ${r.file}`);
    }
    expect(unexpected, `unguarded routes not allowlisted: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("the app layout itself authenticates", () => {
    const src = readFileSync(join(ROOT, "app", "routes", "app.tsx"), "utf8");
    expect(src).toContain("authenticate.admin");
  });
});
