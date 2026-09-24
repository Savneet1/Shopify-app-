import { redirect, type LoaderFunctionArgs } from "react-router";

/**
 * Public entry point. If Shopify sends a `shop` param, hand off to the
 * embedded app (which triggers managed install/auth). Otherwise show a minimal
 * placeholder — merchants always reach the app from the Shopify admin.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { ok: true };
};

export default function Index() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <h1>Search, Filter &amp; Discovery</h1>
      <p>
        This is a Shopify embedded app. Open it from your Shopify admin to get
        started.
      </p>
    </main>
  );
}
