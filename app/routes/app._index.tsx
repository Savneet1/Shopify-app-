import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "~/shopify.server";
import { resolveShopId } from "~/lib/tenant.server";
import { billing } from "~/lib/billing/index.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const subscription = await billing.ensureSubscription({ shopId });
  return {
    shop: session.shop,
    apiVersion,
    plan: subscription.plan,
    billingStatus: subscription.status,
  };
};

/**
 * Phase 1 foundation home. Kept intentionally minimal — the rich Polaris
 * web-component admin UI is built in the later feature phases. App Bridge's
 * TitleBar renders the embedded title bar.
 */
export default function AppHome() {
  const { shop, apiVersion, plan, billingStatus } =
    useLoaderData<typeof loader>();

  return (
    <>
      <TitleBar title="Search, Filter & Discovery" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 760 }}>
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
