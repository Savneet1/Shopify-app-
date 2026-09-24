import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId } from "~/lib/tenant.server";

/**
 * Embedded admin layout.
 *
 * The framework AppProvider loads App Bridge and Polaris web components (the
 * current official mechanism; the deprecated @shopify/polaris React package is
 * intentionally not used). Every embedded route is gated by
 * authenticate.admin(); tenant identity is derived ONLY from the verified
 * session (session.shop) and resolved to an internal shop id server-side.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await resolveShopId(session.shop);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider apiKey={apiKey}>
      <NavMenu>
        <a href="/app" rel="home">
          Home
        </a>
        <a href="/app/sync">Catalog sync</a>
        <a href="/app/search">Search playground</a>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs the app's own error/headers boundaries to keep the embedded
// session healthy on thrown responses.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
