import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";

/**
 * Phase 7 — Storefront install & status (admin).
 *
 * Shows how to enable the theme app extension (app embed = predictive search,
 * app block = search results), provides theme-editor deep links, and runs an
 * in-app status check (is an index active? is the storefront proxy serving?).
 * No new scope: the "enabled in theme?" check is merchant-driven (we cannot read
 * theme files without read_themes, which we deliberately do not request — see
 * docs/PHASE7.md §9).
 */
const EXTENSION_HANDLE = "search-discovery-theme";
const EMBED_HANDLE = "boost-predictive"; // blocks/boost-predictive.liquid
const BLOCK_HANDLE = "boost-results"; //   blocks/boost-results.liquid
const PROXY_PREFIX = "apps";
const PROXY_SUBPATH = "search";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const shopId = await resolveShopId(shop);
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  // Status: is there an active index, and does it hold visible (published +
  // ACTIVE) docs the proxy would serve?
  let indexActive = false;
  let indexVersion: number | null = null;
  let visibleDocs = 0;
  try {
    await withShopExec(shopId, async (exec) => {
      const active = await getActiveVersion(exec, shopId);
      if (active) {
        indexActive = true;
        indexVersion = active.version;
        const rows = await exec.rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM product_search_doc
           WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
             AND published=true AND status='ACTIVE'`,
          [shopId, active.id],
        );
        visibleDocs = rows[0]?.n ?? 0;
      }
    });
  } catch {
    indexActive = false;
  }

  const editorBase = `https://${shop}/admin/themes/current/editor`;
  const embedDeepLink = `${editorBase}?context=apps&template=search&activateAppId=${apiKey}/${EMBED_HANDLE}`;
  const blockDeepLink = `${editorBase}?template=search&addAppBlockId=${apiKey}/${BLOCK_HANDLE}&target=newAppsSection`;
  const proxyBase = `/${PROXY_PREFIX}/${PROXY_SUBPATH}`;

  return {
    shop,
    extension: EXTENSION_HANDLE,
    indexActive,
    indexVersion,
    visibleDocs,
    proxyBase,
    embedDeepLink,
    blockDeepLink,
    hasApiKey: apiKey.length > 0,
  };
};

export default function StorefrontSetup() {
  const d = useLoaderData<typeof loader>();
  const ok = (v: boolean) => (v ? "✓" : "✕");

  return (
    <>
      <TitleBar title="Storefront setup" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 820 }}>
        <h1 style={{ marginTop: 0 }}>Storefront search &amp; filters</h1>
        <p style={{ color: "#555" }}>
          Add the theme app extension to your storefront. The enhancement is
          additive: if JavaScript is blocked or the app is unavailable, your
          theme&rsquo;s standard search keeps working.
        </p>

        <section style={{ border: "1px solid #e3e3e3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Status</h2>
          <ul style={{ lineHeight: 1.7 }}>
            <li>
              {ok(d.indexActive)} Search index{" "}
              {d.indexActive ? `active (v${d.indexVersion}, ${d.visibleDocs} visible products)` : "not active yet — run a sync first"}
            </li>
            <li>
              {ok(d.indexActive && d.visibleDocs > 0)} Storefront proxy{" "}
              <code>{d.proxyBase}/products</code>{" "}
              {d.indexActive && d.visibleDocs > 0
                ? "ready to serve"
                : "will serve once the index has visible products"}
              <div style={{ color: "#8a6d00", fontSize: 13 }}>
                Live reachability from your storefront is confirmed on the store
                itself (open your search page after enabling the blocks below).
              </div>
            </li>
            <li>
              {ok(d.hasApiKey)} App identity for deep links{" "}
              {d.hasApiKey ? "available" : "missing (deploy the app first)"}
            </li>
          </ul>
        </section>

        <section style={{ border: "1px solid #e3e3e3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>1 &middot; Enable predictive search (app embed)</h2>
          <p>
            Turns your theme&rsquo;s existing search box into an accessible
            as-you-type dropdown. Works on all themes.
          </p>
          <a href={d.embedDeepLink} target="_top" rel="noopener"
            style={{ display: "inline-block", padding: "10px 16px", background: "#1a1a1a", color: "#fff", borderRadius: 8, textDecoration: "none" }}>
            Open theme editor &amp; enable
          </a>
          <p style={{ color: "#777", fontSize: 13, marginBottom: 0 }}>
            Or in the theme editor: <em>Theme settings &rarr; App embeds &rarr;
            Predictive search</em>.
          </p>
        </section>

        <section style={{ border: "1px solid #e3e3e3", borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>2 &middot; Add the results block (app block)</h2>
          <p>
            Adds the results grid, filters, sort and pagination to your search
            page. Requires an Online Store 2.0 theme (JSON <code>search.json</code>{" "}
            template).
          </p>
          <a href={d.blockDeepLink} target="_top" rel="noopener"
            style={{ display: "inline-block", padding: "10px 16px", background: "#1a1a1a", color: "#fff", borderRadius: 8, textDecoration: "none" }}>
            Open theme editor &amp; add block
          </a>
          <p style={{ color: "#777", fontSize: 13, marginBottom: 0 }}>
            Or in the theme editor: open the <em>Search</em> template &rarr;{" "}
            <em>Add block</em> &rarr; <em>Apps &rarr; Search results</em>.
          </p>
        </section>

        <section style={{ border: "1px solid #e3e3e3", borderRadius: 10, padding: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Vintage themes</h2>
          <p style={{ marginBottom: 0 }}>
            Older (pre-2.0) themes without JSON templates can use predictive
            search (app embed) but not the results app block. Upgrade to an
            Online Store 2.0 theme, or add the results block manually. See{" "}
            <code>docs/PHASE7_THEME_COMPAT.md</code>.
          </p>
        </section>
      </main>
    </>
  );
}
