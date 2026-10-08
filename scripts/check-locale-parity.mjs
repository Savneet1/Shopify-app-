#!/usr/bin/env node
/*
 * Phase 7 — locale key-parity checker for the theme app extension.
 *
 * Every storefront locale (*.json, excluding *.schema.json) must have exactly
 * the same flattened key set as en.default.json; every schema locale
 * (*.schema.json) must match en.default.schema.json. Exits non-zero (and lists
 * missing/extra keys) on any mismatch. The pure comparison is exported so the
 * vitest suite can assert parity without spawning a process.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "extensions",
  "search-discovery-theme",
  "locales",
);

export function flattenKeys(obj, prefix = "") {
  const out = [];
  for (const k of Object.keys(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flattenKeys(v, key));
    else out.push(key);
  }
  return out.sort();
}

function diff(expected, actual) {
  const e = new Set(expected);
  const a = new Set(actual);
  return {
    missing: expected.filter((k) => !a.has(k)),
    extra: actual.filter((k) => !e.has(k)),
  };
}

/** Returns { ok, problems: [{file, missing, extra}] } for a locales directory. */
export function checkParity(dir = DEFAULT_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const schemaFiles = files.filter((f) => f.endsWith(".schema.json"));
  const stringFiles = files.filter((f) => !f.endsWith(".schema.json"));

  const read = (f) => flattenKeys(JSON.parse(readFileSync(join(dir, f), "utf8")));

  const problems = [];
  const pairs = [
    ["en.default.json", stringFiles],
    ["en.default.schema.json", schemaFiles],
  ];
  for (const [baseName, group] of pairs) {
    if (!group.includes(baseName)) {
      problems.push({ file: baseName, missing: ["<base file absent>"], extra: [] });
      continue;
    }
    const base = read(baseName);
    for (const f of group) {
      if (f === baseName) continue;
      const { missing, extra } = diff(base, read(f));
      if (missing.length || extra.length) problems.push({ file: f, missing, extra });
    }
  }
  return { ok: problems.length === 0, problems };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, problems } = checkParity();
  if (ok) {
    console.log("locale parity OK");
    process.exit(0);
  }
  for (const p of problems) {
    console.error(`[${p.file}] missing: ${p.missing.join(", ") || "-"} | extra: ${p.extra.join(", ") || "-"}`);
  }
  process.exit(1);
}
