import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "~/shopify.server";
import { resolveShopId } from "~/lib/tenant.server";
import { billing } from "~/lib/billing/index.server";
import { prismaRootExec } from "~/lib/db/root-exec.server";
import { checkStatsMaintenanceHealth } from "~/lib/jobs/stats-health.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const subscription = await billing.ensureSubscription({ shopId });
  // Phase 14e E3: observe planner-statistics freshness on the build-output tables
  // (read-only, app_runtime). Exposes no connection string or role name — only a
  // degraded flag — and never throws (fail-open for a cosmetic banner).
  const statsMaintenance = await checkStatsMaintenanceHealth(prismaRootExec());
  return {
    shop: session.shop,
    apiVersion,
    plan: subscription.plan,
    billingStatus: subscription.status,
    statsMaintenanceDegraded: statsMaintenance.degraded,
  };
};

/**
 * Phase 1 foundation home. Kept intentionally minimal — the rich Polaris
 * web-component admin UI is built in the later feature phases. App Bridge's
 * TitleBar renders the embedded title bar.
 */
export default function AppHome() {
  const { shop, apiVersion, plan, billingStatus, statsMaintenanceDegraded } =
    useLoaderData<typeof loader>();

  return (
    <>
      <TitleBar title="Search, Filter & Discovery" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 760 }}>
        {statsMaintenanceDegraded ? (
          <div
            role="status"
            data-testid="stats-maintenance-notice"
            style={{
              border: "1px solid #e0b4b4",
              background: "#fff6f6",
              color: "#9f3a38",
              borderRadius: 8,
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
            }}
          >
            <strong>Database statistics maintenance is not configured or is failing.</strong>{" "}
            Product updates can be much slower after a full catalog sync until it is
            restored. If this persists, contact support.
          </div>
        ) : null}
        <h1 style={{ marginTop: 0 }}>Phase 1 — Foundation</h1>
        <p>
          Connected to <strong>{shop}</strong>. Admin API version{" "}
          <strong>{apiVersion}</strong>. Billing plan <strong>{plan}</strong> (
          {billingStatus}).
        </p>
        <p style={{ color: "#616161" }}>
          This release establishes the multi-tenant foundation: embedded auth,
          per-shop data isolation (PostgreSQL Row-Level Security), privacy
          webhooks, and a billing abstraction. Search, filtering, and
          merchandising arrive in later phases.
        </p>
        <ul>
          <li>Embedded App Bridge + Polaris web components shell</li>
          <li>Managed install / token exchange authentication</li>
          <li>Per-shop Row-Level Security via withShop()</li>
          <li>Privacy &amp; lifecycle webhooks (HMAC-verified, idempotent)</li>
        </ul>
      </main>
    </>
  );
}
