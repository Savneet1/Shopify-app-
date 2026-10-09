import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { loadSettings, saveSettings, type RecommendationSettings } from "~/lib/recommend/settings";
import { getRecommendations, normalizeRecType, type RecType } from "~/lib/recommend/engine";
import type { ContentCard } from "~/lib/recommend/content";

/**
 * Phase 9.6 — Recommendations admin. Enable/disable each type, OOS policy,
 * per-vendor diversification cap, trending half-life, FBT data-source status,
 * and a preview tool (pick a product → see each shelf with a score breakdown,
 * like the search playground's "why is this here?").
 */

interface PreviewResult { type: RecType; products: ContentCard[]; fellBackTo: string | null; reason: string | null; }

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const url = new URL(request.url);
  const previewSeed = url.searchParams.get("seed")?.trim() || "";
  const previewType = normalizeRecType(url.searchParams.get("ptype")) ?? "similar";

  const { settings, preview } = await withShopExec(shopId, async (e) => {
    const settings = await loadSettings(e, shopId);
    let preview: PreviewResult | null = null;
    if (previewSeed) {
      const r = await getRecommendations(e, shopId, { type: previewType, seed: previewSeed, limit: 12, explain: true });
      preview = { type: r.type, products: r.products, fellBackTo: r.fellBackTo, reason: r.reason };
    }
    return { settings, preview };
  });
  return { settings, preview, previewSeed, previewType };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const b = (k: string) => form.get(k) === "on";
  const input: Partial<RecommendationSettings> = {
    similarEnabled: b("similarEnabled"),
    relatedEnabled: b("relatedEnabled"),
    trendingEnabled: b("trendingEnabled"),
    fbtEnabled: b("fbtEnabled"),
    recentEnabled: b("recentEnabled"),
    includeOutOfStock: b("includeOutOfStock"),
    fbtFallbackRelated: b("fbtFallbackRelated"),
    diversifyPerVendor: Number(form.get("diversifyPerVendor") || 0),
    trendingHalfLifeDays: Number(form.get("trendingHalfLifeDays") || 7),
  };
  try {
    await withShopExec(shopId, (e) => saveSettings(e, shopId, input));
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

const TYPES: RecType[] = ["similar", "related", "trending", "fbt", "recent"];

export default function Recommendations() {
  const { settings, preview, previewSeed, previewType } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const row = { display: "flex", gap: 8, alignItems: "center" } as const;

  return (
    <>
      <TitleBar title="Recommendations" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 900 }}>
        <h1 style={{ marginTop: 0 }}>Recommendations</h1>
        <p style={{ color: "#555" }}>
          Rule-based, deterministic recommendations computed from your active search index — no
          machine learning, no external services, no per-shopper profiles. Similar, related,
          trending and recently-viewed need no extra data. Results always reflect only
          published, in-stock-by-default products from the current index version.
        </p>

        <Form method="post" style={{ display: "grid", gap: 10, maxWidth: 560, border: "1px solid #e3e3e3", borderRadius: 8, padding: 16 }}>
          <strong>Enabled shelves</strong>
          <label style={row}><input type="checkbox" name="similarEnabled" defaultChecked={settings.similarEnabled} /> Similar products</label>
          <label style={row}><input type="checkbox" name="relatedEnabled" defaultChecked={settings.relatedEnabled} /> Related products</label>
          <label style={row}><input type="checkbox" name="trendingEnabled" defaultChecked={settings.trendingEnabled} /> Trending</label>
          <label style={row}><input type="checkbox" name="recentEnabled" defaultChecked={settings.recentEnabled} /> Recently viewed</label>
          <label style={row}><input type="checkbox" name="fbtEnabled" defaultChecked={settings.fbtEnabled} /> Frequently bought together</label>

          <div style={{ background: "#fff8e1", border: "1px solid #ffe08a", borderRadius: 6, padding: 10, fontSize: 13, color: "#7a5b00" }}>
            <strong>Frequently-bought-together data source: Requires Verification.</strong> Real FBT
            needs Shopify order history (<code>read_orders</code>, and possibly protected customer
            data / <code>read_all_orders</code>). That access is <em>not</em> enabled in this build, so
            no order data is read and no co-occurrence is computed. The algorithm and storage are in
            place and fully tested against a synthetic basket source; until an order source is
            approved and wired, FBT returns nothing and (below) can degrade to related products.
          </div>
          <label style={row}><input type="checkbox" name="fbtFallbackRelated" defaultChecked={settings.fbtFallbackRelated} /> When FBT has no data, show related products instead</label>

          <strong style={{ marginTop: 8 }}>Behaviour</strong>
          <label style={row}><input type="checkbox" name="includeOutOfStock" defaultChecked={settings.includeOutOfStock} /> Include out-of-stock products</label>
          <label style={row}>Max items per vendor (0 = off)
            <input type="number" name="diversifyPerVendor" min={0} max={24} defaultValue={settings.diversifyPerVendor} style={{ width: 80 }} />
          </label>
          <label style={row}>Trending half-life (days)
            <input type="number" name="trendingHalfLifeDays" min={1} max={90} defaultValue={settings.trendingHalfLifeDays} style={{ width: 80 }} />
          </label>
          <button type="submit" disabled={busy} style={{ width: 160 }}>Save settings</button>
        </Form>

        <h2 style={{ marginTop: 28 }}>Preview — “why is this here?”</h2>
        <Form method="get" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <input name="seed" placeholder="product handle or gid" defaultValue={previewSeed} style={{ width: 320 }} />
          <select name="ptype" defaultValue={previewType}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="submit" disabled={busy}>Preview</button>
        </Form>

        {preview && (
          <div>
            <div style={{ color: "#555", fontSize: 13, marginBottom: 8 }}>
              {preview.products.length} result(s)
              {preview.fellBackTo ? ` · fell back to ${preview.fellBackTo}` : ""}
              {preview.reason ? ` · ${preview.reason}` : ""}
            </div>
            <ol style={{ paddingLeft: 18 }}>
              {preview.products.map((p) => (
                <li key={p.id} style={{ marginBottom: 6 }}>
                  <strong>{p.title}</strong> <code style={{ color: "#777" }}>{p.vendor} · {p.productType}</code>
                  {" "}· score {Number(p.score).toFixed(2)}
                  {p.breakdown && (
                    <span style={{ color: "#777", fontSize: 12 }}>
                      {" "}(collections {p.breakdown.collections.toFixed(0)}, type {p.breakdown.productType.toFixed(0)},
                      vendor {p.breakdown.vendor.toFixed(0)}, tags {p.breakdown.tags.toFixed(0)},
                      price {p.breakdown.price.toFixed(1)}, title {p.breakdown.title.toFixed(1)})
                    </span>
                  )}
                </li>
              ))}
              {preview.products.length === 0 && <li style={{ color: "#999" }}>No results (unknown seed, disabled shelf, or no data).</li>}
            </ol>
          </div>
        )}
      </main>
    </>
  );
}
