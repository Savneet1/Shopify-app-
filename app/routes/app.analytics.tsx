import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import {
  loadAnalyticsSettings, saveAnalyticsSettings, MAX_RETENTION_DAYS, type AnalyticsMode,
} from "~/lib/analytics/settings";
import {
  resolveWindow, summaryReport, topQueries, topZeroResultQueries,
  queriesWithNoClicks, perSurface, dailyTrend,
  type SummaryReport, type QueryRow, type SurfaceRow, type TrendRow,
} from "~/lib/analytics/reports";
import { deleteAllAnalytics } from "~/lib/analytics/store";

/**
 * Phase 11.7 — Analytics admin. Settings (mode + retention), a date-range
 * picker, the reports (dependency-free inline-SVG/CSS charts built from escaped
 * text), and a "Delete all analytics data" action (own shop, confirmed). CSV
 * export is a sibling resource route (app.analytics.export).
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const data = await withShopExec(shopId, async (e) => {
    const settings = await loadAnalyticsSettings(e, shopId);
    if (settings.mode === "off") {
      return { settings, window: null, summary: null, top: [], zero: [], noClicks: [], surfaces: [], trend: [] };
    }
    const w = await resolveWindow(e, shopId, { from, to });
    const [summary, top, zero, noClicks, surfaces, trend] = [
      await summaryReport(e, shopId, w),
      await topQueries(e, shopId, w, 20),
      await topZeroResultQueries(e, shopId, w, 20),
      await queriesWithNoClicks(e, shopId, w, 20),
      await perSurface(e, shopId, w),
      await dailyTrend(e, shopId, w),
    ];
    return { settings, window: w, summary, top, zero, noClicks, surfaces, trend };
  });
  return data;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  try {
    if (intent === "delete-all") {
      if (String(form.get("confirm")) !== "DELETE") return { error: "Type DELETE to confirm." };
      const n = await withShopExec(shopId, (e) => deleteAllAnalytics(e, shopId));
      return { ok: true, deleted: n };
    }
    const mode = String(form.get("mode")) as AnalyticsMode;
    const retentionDays = Number(form.get("retentionDays") || 90);
    await withShopExec(shopId, (e) => saveAnalyticsSettings(e, shopId, { mode, retentionDays }));
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

const pct = (n: number) => (n * 100).toFixed(1) + "%";

function Bars({ rows }: { rows: TrendRow[] }) {
  if (rows.length === 0) return <p style={{ color: "#999" }}>No data in this window.</p>;
  const max = Math.max(1, ...rows.map((r) => r.searches));
  const w = 18, gap = 4, h = 80;
  return (
    <svg width={rows.length * (w + gap)} height={h + 18} role="img" aria-label="Daily searches">
      {rows.map((r, i) => {
        const bh = Math.round((r.searches / max) * h);
        return (
          <g key={r.day}>
            <rect x={i * (w + gap)} y={h - bh} width={w} height={bh} fill="#1a56db">
              <title>{`${r.day}: ${r.searches} searches, ${r.clicks} clicks`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

export default function Analytics() {
  const d = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const s = d.summary as SummaryReport | null;

  return (
    <>
      <TitleBar title="Analytics" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 960 }}>
        <h1 style={{ marginTop: 0 }}>Search analytics</h1>
        <p style={{ color: "#555" }}>
          First-party, privacy-preserving search analytics. No IPs, user-agents, fingerprints or
          customer identifiers are stored; query text is normalized and PII-redacted. Off by default.
        </p>

        <Form method="post" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", border: "1px solid #e3e3e3", borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <label>Mode
            <select name="mode" defaultValue={d.settings.mode}>
              <option value="off">off (collect nothing)</option>
              <option value="anonymous">anonymous (no session id)</option>
              <option value="consented_sessions">consented sessions</option>
            </select>
          </label>
          <label>Retention (days, max {MAX_RETENTION_DAYS})
            <input name="retentionDays" type="number" min={1} max={MAX_RETENTION_DAYS} defaultValue={d.settings.retentionDays} style={{ width: 90 }} />
          </label>
          <button type="submit" disabled={busy}>Save</button>
        </Form>

        {d.settings.mode === "off" ? (
          <p style={{ color: "#a15c00" }}>Analytics is off. Choose <strong>anonymous</strong> or <strong>consented sessions</strong> above and save to begin collecting.</p>
        ) : (
          <>
            <Form method="get" style={{ display: "flex", gap: 8, alignItems: "end", marginBottom: 14 }}>
              <label>From <input name="from" type="date" defaultValue={d.window?.fromDay} /></label>
              <label>To <input name="to" type="date" defaultValue={d.window?.toDay} /></label>
              <button type="submit" disabled={busy}>Apply</button>
              <span style={{ color: "#777", fontSize: 12 }}>Window is clamped to your {d.settings.retentionDays}-day retention.</span>
            </Form>

            {s && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginBottom: 16 }}>
                {[
                  ["Searches", String(s.searches)],
                  ["Zero-result rate", pct(s.zeroResultRate)],
                  ["Click-through rate", pct(s.clickThroughRate)],
                  ["Add-to-cart rate", pct(s.addToCartRate)],
                  ["Redirects", String(s.redirects)],
                ].map(([label, val]) => (
                  <div key={label} style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
                    <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700 }}>{val}</div>
                  </div>
                ))}
              </div>
            )}

            <h2 style={{ fontSize: 16 }}>Daily searches</h2>
            <Bars rows={d.trend as TrendRow[]} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 16 }}>
              <QueryTable title="Top queries" rows={d.top as QueryRow[]} metric="searches" />
              <QueryTable title="Top zero-result queries" rows={d.zero as QueryRow[]} metric="zeroResults" />
              <QueryTable title="Queries with no clicks" rows={d.noClicks as QueryRow[]} metric="searches" />
              <SurfaceTable rows={d.surfaces as SurfaceRow[]} />
            </div>

            <h2 style={{ fontSize: 16, marginTop: 20 }}>Export (CSV)</h2>
            <p style={{ fontSize: 13 }}>
              <a href={`/app/analytics/export?type=queries&from=${d.window?.fromDay}&to=${d.window?.toDay}`}>Top queries</a>{" · "}
              <a href={`/app/analytics/export?type=zero&from=${d.window?.fromDay}&to=${d.window?.toDay}`}>Zero-result queries</a>{" · "}
              <a href={`/app/analytics/export?type=events&from=${d.window?.fromDay}&to=${d.window?.toDay}`}>Raw events</a>
            </p>

            <h2 style={{ fontSize: 16, marginTop: 20, color: "#b00020" }}>Danger zone</h2>
            <Form method="post" onSubmit={(e) => { if (!confirm("Delete ALL analytics data for this shop? This cannot be undone.")) e.preventDefault(); }}
              style={{ border: "1px solid #f3c2c2", borderRadius: 8, padding: 12 }}>
              <input type="hidden" name="intent" value="delete-all" />
              <label>Type <code>DELETE</code> to confirm: <input name="confirm" placeholder="DELETE" /></label>
              <button type="submit" disabled={busy} style={{ marginLeft: 8, color: "#b00020" }}>Delete all analytics data</button>
            </Form>
          </>
        )}
      </main>
    </>
  );
}

function QueryTable({ title, rows, metric }: { title: string; rows: QueryRow[]; metric: "searches" | "zeroResults" }) {
  return (
    <div>
      <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>{title}</h3>
      <table style={{ fontSize: 13, borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th style={{ textAlign: "left" }}>Query</th><th style={{ textAlign: "right" }}>Searches</th><th style={{ textAlign: "right" }}>Clicks</th><th style={{ textAlign: "right" }}>Zero</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}><td>{r.query}</td><td style={{ textAlign: "right" }}>{r.searches}</td><td style={{ textAlign: "right" }}>{r.clicks}</td><td style={{ textAlign: "right" }}>{r.zeroResults}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} style={{ color: "#999" }}>No data.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function SurfaceTable({ rows }: { rows: SurfaceRow[] }) {
  return (
    <div>
      <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>Events per surface</h3>
      <table style={{ fontSize: 13, borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th style={{ textAlign: "left" }}>Surface</th><th style={{ textAlign: "right" }}>Events</th></tr></thead>
        <tbody>
          {rows.map((r) => (<tr key={r.surface}><td>{r.surface}</td><td style={{ textAlign: "right" }}>{r.events}</td></tr>))}
          {rows.length === 0 && <tr><td colSpan={2} style={{ color: "#999" }}>No data.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
