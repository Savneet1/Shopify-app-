import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { buildCsv } from "~/lib/analytics/csv";
import { listSubscriptions } from "~/lib/restock/admin";

/**
 * Phase 12.6 — subscriptions CSV export (admin, own shop only). Emails are
 * MASKED; the existing CSV formula-injection protection + hard row cap apply.
 * Never 5xx on bad params.
 */
const MAX_ROWS = 50000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const url = new URL(request.url);
  const emailQuery = url.searchParams.get("q");

  const rows = await withShopExec(shopId, (e) => listSubscriptions(e, shopId, { emailQuery, limit: MAX_ROWS }));
  const csv = buildCsv(
    ["created_at", "status", "masked_email", "product_gid", "variant_gid", "locale", "source"],
    rows.map((r) => [r.createdAt, r.status, r.maskedEmail, r.shopifyProductGid, r.variantGid ?? "", r.locale, r.source ?? ""]),
    MAX_ROWS,
  );

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="back-in-stock-subscriptions.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
