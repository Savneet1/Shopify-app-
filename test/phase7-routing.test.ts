import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/*
 * Phase 7.1 F3 — routing regression guard. The unregistered-routes gap (App
 * Proxy + admin pages present on disk but absent from the explicit route table)
 * went unnoticed for six phases. These static checks fail if any route module
 * is left unregistered, or if the App Proxy config drifts from the registered
 * proxy routes / the extension's default proxyBase.
 *
 * (F3 part 3 — an unsigned proxy request returning HTTP 400 — needs the
 * generated Prisma client, which is unavailable in this egress-blocked sandbox;
 * it lives in test/prisma-integration.test.ts and runs on CI. See
 * docs/PHASE7_REPORT.md.)
 */
const ROOT = join(__dirname, "..");
const routesTs = readFileSync(join(ROOT, "app", "routes.ts"), "utf8");
const toml = readFileSync(join(ROOT, "shopify.app.toml"), "utf8");

describe("F3 — every route module is registered exactly once", () => {
  it("app/routes.ts references each app/routes/*.tsx file exactly once", () => {
    const files = readdirSync(join(ROOT, "app", "routes")).filter((f) => f.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const needle = `"routes/${f}"`; // exact quoted module path, with .tsx
      const count = routesTs.split(needle).length - 1;
      expect(count, `${f} should be registered exactly once (found ${count})`).toBe(1);
    }
  });

  it("every registered module path points to a file that exists", () => {
    const refs = routesTs.match(/routes\/[A-Za-z0-9_.$-]+\.tsx/g) || [];
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      const file = join(ROOT, "app", r);
      expect(readFileSync(file, "utf8").length, r).toBeGreaterThan(0);
    }
  });
});

describe("F3 — App Proxy config maps to the registered proxy routes", () => {
  function tomlValue(section: string, key: string): string | null {
    // crude [app_proxy] block scan
    const m = toml.match(new RegExp("\\[" + section + "\\]([\\s\\S]*?)(?:\\n\\[|$)"));
    if (!m) return null;
    const line = m[1].match(new RegExp("^\\s*" + key + '\\s*=\\s*"([^"]*)"', "m"));
    return line ? line[1] : null;
  }

  it("prefix/subpath form /apps/search and match the extension default proxyBase", () => {
    const prefix = tomlValue("app_proxy", "prefix");
    const subpath = tomlValue("app_proxy", "subpath");
    expect(prefix).toBe("apps");
    expect(subpath).toBe("search");
    const proxyBase = `/${prefix}/${subpath}`;
    expect(proxyBase).toBe("/apps/search");

    // The theme blocks default to the same prefix/subpath.
    const predictive = readFileSync(join(ROOT, "extensions", "search-discovery-theme", "blocks", "boost-predictive.liquid"), "utf8");
    const results = readFileSync(join(ROOT, "extensions", "search-discovery-theme", "blocks", "boost-results.liquid"), "utf8");
    for (const src of [predictive, results]) {
      expect(/default:\s*'apps'/.test(src)).toBe(true);
      expect(/default:\s*'search'/.test(src)).toBe(true);
    }
    // The admin status page uses the same defaults.
    const admin = readFileSync(join(ROOT, "app", "routes", "app.storefront.tsx"), "utf8");
    expect(/PROXY_PREFIX\s*=\s*"apps"/.test(admin)).toBe(true);
    expect(/PROXY_SUBPATH\s*=\s*"search"/.test(admin)).toBe(true);
  });

  it("the proxy url path has matching proxy/* routes registered", () => {
    const url = tomlValue("app_proxy", "url");
    expect(url).toBeTruthy();
    const pathname = new URL(url as string).pathname.replace(/\/$/, ""); // e.g. /proxy
    expect(pathname).toBe("/proxy");
    for (const endpoint of ["products", "predictive", "suggest"]) {
      const routePath = `${pathname.slice(1)}/${endpoint}`; // proxy/products
      expect(routesTs.includes(`"${routePath}"`), routePath).toBe(true);
      expect(readFileSync(join(ROOT, "app", "routes", `proxy.${endpoint}.tsx`), "utf8").length).toBeGreaterThan(0);
    }
  });
});
