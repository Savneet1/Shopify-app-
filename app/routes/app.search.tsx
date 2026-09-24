import type { LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId } from "~/lib/tenant.server";
import { storefrontSearch } from "~/lib/search/storefront";

/**
 * Admin "Search playground" (Phase 3.7). Session-authenticated (embedded). Lets
 * a merchant type a query and see exactly what the storefront API would return
 * for their OWN shop — products, the winning strategy, result count, timing,
 * zero-result state and catalog suggestions. It calls the SAME storefrontSearch
 * used by the App Proxy endpoint, under the merchant's tenant context (RLS), so
 * what they see here is what shoppers get.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  if (!q.trim()) {
    return { q, result: null };
  }
  const result = await storefrontSearch(shopId, { q, limit: 24 });
  return { q, result };
};

export default function SearchPlayground() {
  const { q, result } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <>
      <TitleBar title="Search playground" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 860 }}>
        <h1 style={{ marginTop: 0 }}>Search playground</h1>
        <p style={{ color: "#555" }}>
          Test the storefront search for your shop. Results come from the active
          search index — the exact response shoppers receive.
        </p>

        <Form method="get" style={{ display: "flex", gap: 8, margin: "1rem 0" }}>
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search products…"
            aria-label="Search query"
            style={{ flex: 1, padding: "0.5rem 0.75rem", fontSize: 16 }}
          />
          <button type="submit" disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </button>
        </Form>

        {result && (
          <section>
            <p style={{ color: "#555" }}>
              <strong>{result.total}</strong> result{result.total === 1 ? "" : "s"} ·
              strategy <code>{result.strategy}</code> ·{" "}
              {result.indexVersion != null ? `index v${result.indexVersion}` : "no index"} ·{" "}
              {result.tookMs}ms
              {result.fallback ? ` · fallback: ${result.fallback}` : ""}
              {result.zeroResult ? " · zero-result" : ""}
            </p>

            {result.fallback === "native" && (
              <p style={{ background: "#fff4e5", padding: "0.75rem", borderRadius: 6 }}>
                The app could not serve results (no active index yet, timeout, or
                error). The storefront would fall back to the theme's native
                search.
              </p>
            )}

            {result.products.length > 0 ? (
              <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
                {result.products.map((p) => (
                  <li
                    key={p.id}
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                      border: "1px solid #eee",
                      borderRadius: 8,
                      padding: 10,
                    }}
                  >
                    {p.image.url ? (
                      // eslint-disable-next-line jsx-a11y/img-redundant-alt
                      <img
                        src={p.image.url}
                        alt={p.image.alt ?? p.title ?? ""}
                        width={56}
                        height={56}
                        style={{ objectFit: "cover", borderRadius: 6, background: "#f6f6f6" }}
                      />
                    ) : (
                      <div style={{ width: 56, height: 56, background: "#f6f6f6", borderRadius: 6 }} />
                    )}
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{p.title}</div>
                      <div style={{ color: "#666", fontSize: 14 }}>
                        {p.vendor}
                        {p.productType ? ` · ${p.productType}` : ""}
                        {p.priceMin != null ? ` · ${formatRange(p.priceMin, p.priceMax)}` : ""}
                        {p.available ? "" : " · out of stock"}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              !result.fallback && <p>No products matched “{result.query}”.</p>
            )}

            {result.zeroResult && result.suggestions.length > 0 && (
              <div>
                <h3>Suggestions from your catalog</h3>
                <ul>
                  {result.suggestions.map((s, i) => (
                    <li key={i}>
                      {s.text} <span style={{ color: "#999" }}>({s.type})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {!result && params.get("q") == null && (
          <p style={{ color: "#888" }}>Enter a query above to see results.</p>
        )}
      </main>
    </>
  );
}

function formatRange(min: string, max: string | null): string {
  if (max == null || min === max) return `${min}`;
  return `${min} – ${max}`;
}
