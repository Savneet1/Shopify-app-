import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { SUPPORTED_LOCALES } from "~/lib/i18n/locales";
import { loadCombinedMode, saveCombinedMode, type CombinedMode } from "~/lib/search/combined";
import type { Exec } from "~/lib/db/executor";

/**
 * Phase 13.6 — Localization & market context admin.
 *
 * Surfaces: supported UI locales + translation-review status; locale-scoped
 * search personalisation counts (synonyms / stop words / redirects); the
 * combined-listing display mode (the one server-side setting on this page) with
 * parent/child counts; where to find the client-only toggles (price hydration,
 * personalised suggestions) that live in the theme editor; the honest B2B
 * limitations; and a "what this app does NOT do" panel.
 */

interface Counts {
  synGlobal: number; synLocale: number;
  stopGlobal: number; stopLocale: number;
  redirGlobal: number; redirLocale: number;
  combinedParents: number; combinedChildren: number;
}

async function loadCounts(e: Exec, shopId: string): Promise<Counts> {
  const one = async (sql: string) =>
    Number((await e.rows<{ n: number }>(sql, [shopId]))[0]?.n ?? 0);
  return {
    synGlobal: await one(`SELECT count(*)::int n FROM search_synonym WHERE shop_id=$1::uuid AND locale IS NULL`),
    synLocale: await one(`SELECT count(*)::int n FROM search_synonym WHERE shop_id=$1::uuid AND locale IS NOT NULL`),
    stopGlobal: await one(`SELECT count(*)::int n FROM search_stopword WHERE shop_id=$1::uuid AND locale IS NULL`),
    stopLocale: await one(`SELECT count(*)::int n FROM search_stopword WHERE shop_id=$1::uuid AND locale IS NOT NULL`),
    redirGlobal: await one(`SELECT count(*)::int n FROM search_redirect WHERE shop_id=$1::uuid AND locale IS NULL`),
    redirLocale: await one(`SELECT count(*)::int n FROM search_redirect WHERE shop_id=$1::uuid AND locale IS NOT NULL`),
    combinedParents: await one(`SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND combined_role='PARENT' AND deleted_at IS NULL`),
    combinedChildren: await one(`SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND combined_role='CHILD' AND deleted_at IS NULL`),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const { mode, counts } = await withShopExec(shopId, async (e) => ({
    mode: await loadCombinedMode(e, shopId),
    counts: await loadCounts(e, shopId),
  }));
  return { locales: SUPPORTED_LOCALES, mode, counts };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const mode = String(form.get("combinedMode") || "show_all") as CombinedMode;
  try {
    const saved = await withShopExec(shopId, (e) => saveCombinedMode(e, shopId, mode));
    return { ok: true, mode: saved };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

const REVIEW_LABEL: Record<string, string> = {
  source: "Source (English)",
  reviewed: "Reviewed",
  "needs-native-review": "Needs native review",
};

export default function Localization() {
  const { locales, mode, counts } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const card = { border: "1px solid #e3e3e3", borderRadius: 8, padding: 16, marginBottom: 20 } as const;

  return (
    <>
      <TitleBar title="Localization & markets" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 940 }}>
        <h1 style={{ marginTop: 0 }}>Localization &amp; markets</h1>
        <p style={{ color: "#555" }}>
          How this app behaves across languages and markets. Everything here is rule-based and
          deterministic. The app requests only <code>read_products</code>; it uses no Markets,
          Translations, Companies or Customers scopes.
        </p>

        <section style={card}>
          <h2 style={{ marginTop: 0 }}>Storefront UI languages</h2>
          <p style={{ color: "#555", fontSize: 13 }}>
            The storefront widgets ship these locales. The visitor's language is resolved
            exact&nbsp;→&nbsp;base&nbsp;→&nbsp;English, and the app sets text direction on its own
            root only (so Arabic renders right-to-left without changing your theme).
          </p>
          <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
            <thead><tr><th style={th}>Locale</th><th style={th}>Direction</th><th style={th}>Translation status</th></tr></thead>
            <tbody>
              {locales.map((l) => (
                <tr key={l.code}>
                  <td style={td}><code>{l.code}</code></td>
                  <td style={td}>{l.dir.toUpperCase()}</td>
                  <td style={td}>
                    {REVIEW_LABEL[l.review] ?? l.review}
                    {l.review === "needs-native-review" && (
                      <span style={{ color: "#7a5b00" }}> — machine-assisted, pending a native speaker</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section style={card}>
          <h2 style={{ marginTop: 0 }}>Locale-scoped search personalisation</h2>
          <p style={{ color: "#555", fontSize: 13 }}>
            Synonyms, stop words and redirects can be global (apply to every language) or scoped to
            one locale. A global rule always applies; a locale rule applies only when the visitor's
            resolved locale matches. With no locale-specific rows the behaviour is identical to a
            single-language store.
          </p>
          <ul style={{ fontSize: 14, lineHeight: 1.7 }}>
            <li>Synonyms: {counts.synGlobal} global · {counts.synLocale} locale-scoped</li>
            <li>Stop words: {counts.stopGlobal} global · {counts.stopLocale} locale-scoped</li>
            <li>Redirects: {counts.redirGlobal} global · {counts.redirLocale} locale-scoped</li>
          </ul>
        </section>

        <section style={card}>
          <h2 style={{ marginTop: 0 }}>Combined listings</h2>
          <p style={{ color: "#555", fontSize: 13 }}>
            Read-only. The app reads each product's combined-listing role (<code>read_products</code>)
            and can hide either the parent or the child products everywhere search appears — results,
            totals, facet counts, predictive, suggestions and recommendations — as one hard rule.
            Parent cards additionally show the aggregate price range across their children.
          </p>
          <p style={{ fontSize: 14 }}>
            Detected in your catalogue: <strong>{counts.combinedParents}</strong> parent
            {counts.combinedParents === 1 ? "" : "s"} · <strong>{counts.combinedChildren}</strong> child
            {counts.combinedChildren === 1 ? "" : "ren"}.
          </p>
          <Form method="post" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label htmlFor="combinedMode">Display mode</label>
            <select id="combinedMode" name="combinedMode" defaultValue={mode}>
              <option value="show_all">Show all (parents and children)</option>
              <option value="hide_children">Hide child products</option>
              <option value="hide_parents">Hide parent products</option>
            </select>
            <button type="submit" disabled={busy}>Save</button>
          </Form>
        </section>

        <section style={card}>
          <h2 style={{ marginTop: 0 }}>Market-specific prices &amp; personalised suggestions</h2>
          <p style={{ color: "#555", fontSize: 13 }}>
            These are <strong>client-side, opt-in</strong> options you turn on in the theme editor on
            each app block (Online Store → Themes → Customize), not here:
          </p>
          <ul style={{ fontSize: 14, lineHeight: 1.7 }}>
            <li>
              <strong>Show market-specific prices</strong> (Search results block, default off): each
              result card fetches its live price from your storefront (<code>/products/&lt;handle&gt;.js</code>,
              same-origin, no extra scope) and reformats it in the visitor's active currency. Adds one
              small request per card. <em>Requires Verification</em> on a real Markets store.
            </li>
            <li>
              <strong>Personalised suggestions</strong> (Predictive block, default on): recent searches
              and interest weights stay in the visitor's own browser and are used only after analytics
              consent. The server stores and logs nothing; searches that look like personal data are
              never stored; the visitor can turn it off or clear their history from the search box.
            </li>
          </ul>
        </section>

        <section style={{ ...card, background: "#fff8e1", borderColor: "#ffe08a" }}>
          <h2 style={{ marginTop: 0 }}>B2B (wholesale) — not implemented</h2>
          <p style={{ color: "#7a5b00", fontSize: 13, margin: 0 }}>
            Company-specific catalogues and negotiated B2B prices need the{" "}
            <code>read_companies</code> / <code>read_customers</code> scopes, which this app does not
            request. It therefore does <strong>not</strong> use or store the logged-in customer id and
            never shows a per-company price. The only market-aware pricing it offers is the client-side
            hydration above, which reflects the storefront's own presentment price.
          </p>
        </section>

        <section style={{ ...card, background: "#f1f5ff", borderColor: "#c7d7ff" }}>
          <h2 style={{ marginTop: 0 }}>What this app does <em>not</em> do</h2>
          <ul style={{ fontSize: 14, lineHeight: 1.7, margin: 0 }}>
            <li>No Markets, Translations, Companies or Customers API access (no new scopes).</li>
            <li>No server-side profile of any shopper; interest data is browser-only and consent-gated.</li>
            <li>No machine translation at runtime — UI strings are shipped per locale and marked for review.</li>
            <li>No currency conversion of its own; price hydration shows the storefront's presentment price.</li>
            <li>No B2B/company pricing, and no use of the logged-in customer id.</li>
          </ul>
        </section>
      </main>
    </>
  );
}

const th = { textAlign: "left", borderBottom: "2px solid #e3e3e3", padding: "6px 14px 6px 0" } as const;
const td = { borderBottom: "1px solid #f0f0f0", padding: "6px 14px 6px 0" } as const;
