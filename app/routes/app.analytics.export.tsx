import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { resolveWindow, topQueries, topZeroResultQueries } from "~/lib/analytics/reports";
import { buildCsv } from "~/lib/analytics/csv";
import { Params } from "~/lib/search/filters";

/**
 * Phase 11.7 — CSV export (admin, own shop only). type = queries | zero |
 * events. Hard row cap; CSV formula-injection protection via buildCsv. Raw
 * events export omits nothing sensitive because events carry no PII (query_norm
 * is already normalized + redacted). Never 5xx on bad params (defaults applied).
 */
const MAX_ROWS = 50000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "queries";
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const { filename, csv } = await withShopExec(shopId, async (e) => {
    const w = await resolveWindow(e, shopId, { from, to });
    if (type === "zero") {
      const rows = await topZeroResultQueries(e, shopId, w, 1000);
      return {
        filename: "zero-result-queries.csv",
        csv: buildCsv(["query", "zero_results"], rows.map((r) => [r.query, r.zeroResults]), MAX_ROWS),
      };
    }
    if (type === "events") {
      const pb = new Params();
      const sid = pb.add(shopId);
      const f = pb.add(w.fromDay);
      const t = pb.add(w.toDay);
      const lim = pb.add(MAX_ROWS);
      const rows = await e.rows<{
        occurred_at: string; event_type: string; surface: string; query_norm: string | null;
        result_count: number | null; product_gid: string | null; position: number | null; variant: string | null;
      }>(
        `SELECT occurred_at, event_type, surface, query_norm, result_count, product_gid, position, variant
         FROM analytics_event
         WHERE shop_id=${sid}::uuid AND occurred_at >= (${f}::date) AND occurred_at < ((${t}::date)+1)
         ORDER BY occurred_at DESC
         LIMIT ${lim}::int`,
        pb.values,
      );
      return {
        filename: "analytics-events.csv",
        csv: buildCsv(
          ["occurred_at", "event_type", "surface", "query_norm", "result_count", "product_gid", "position", "variant"],
          rows.map((r) => [r.occurred_at, r.event_type, r.surface, r.query_norm ?? "", r.result_count ?? "", r.product_gid ?? "", r.position ?? "", r.variant ?? ""]),
          MAX_ROWS,
        ),
      };
    }
    // default: top queries
    const rows = await topQueries(e, shopId, w, 1000);
    return {
      filename: "top-queries.csv",
      csv: buildCsv(["query", "searches", "clicks", "zero_results"], rows.map((r) => [r.query, r.searches, r.clicks, r.zeroResults]), MAX_ROWS),
    };
  });

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
};
