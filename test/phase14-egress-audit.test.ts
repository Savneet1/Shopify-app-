import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase 14.4e — EGRESS audit. Statically list every outbound-network primitive
 * in app/ code and FAIL if one appears outside the allowlisted modules. The app
 * talks to exactly two external destinations: the Shopify Admin API (bulk +
 * single-entity fetch) and the merchant's configured SMTP server. Any new
 * fetch/socket elsewhere (an exfiltration path, a sneaky third-party call) trips
 * this test.
 */

const APP = join(__dirname, "..", "app");

// Modules permitted to open an outbound connection, each with its destination.
const EGRESS_ALLOWLIST: Record<string, string> = {
  "lib/shopify/bulk.server.ts": "Shopify Admin API (bulk result download + GraphQL)",
  "lib/email/smtp.ts": "merchant-configured SMTP server (policy-checked host)",
};

// Match actual CALLS of network primitives, not the words in comments.
const NET_RE = /(^|[^.\w])fetch\s*\(|tls\.connect\s*\(|net\.connect\s*\(|net\.createConnection\s*\(|https?\.request\s*\(|new\s+WebSocket\s*\(|dgram\.|createTransport\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/** Strip // line comments and /* block comments *​/ so a commented "fetch(" is
 * not a false positive. Simple but sufficient for this audit. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("Phase 14.4e — egress audit", () => {
  const files = walk(APP);

  it("finds a reasonable number of app source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no outbound-network primitive outside the allowlisted modules", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(APP.length + 1).replace(/\\/g, "/");
      if (rel in EGRESS_ALLOWLIST) continue;
      const code = stripComments(readFileSync(f, "utf8"));
      const lines = code.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (NET_RE.test(lines[i])) offenders.push(`${rel}:${i + 1}  ${lines[i].trim().slice(0, 80)}`);
      }
    }
    expect(offenders, `outbound network calls outside the allowlist:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the allowlisted modules DO contain the expected egress (guards against a dead allowlist)", () => {
    for (const rel of Object.keys(EGRESS_ALLOWLIST)) {
      const code = stripComments(readFileSync(join(APP, rel), "utf8"));
      expect(NET_RE.test(code), `${rel} no longer performs egress; prune the allowlist`).toBe(true);
    }
  });
});
