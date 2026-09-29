import type { LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId } from "~/lib/tenant.server";
import { storefrontSearch } from "~/lib/search/storefront";
import { filtersFromSearchParams } from "~/lib/search/params";
import { FilterValidationError } from "~/lib/search/filters";
import { FACET_METAFIELD } from "~/lib/search/config";

/**
 * Admin "Search playground" (Phase 3) + Phase 4 filter panel. Session-auth'd.
 * Runs the SAME storefrontSearch shoppers hit, under the merchant's tenant
 * context, and shows products + live facet counts. Selecting facet options
 * re-submits the GET form so counts update ("own selection doesn't zero itself"
 * behaviour is visible here).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const filters = filtersFromSearchParams(url.searchParams);
  const hasInput = q.trim() !== "" || url.searchParams.toString() !== "";
  if (!hasInput) return { q, result: null, error: null, metafieldKey: FACET_METAFIELD.key };
  try {
    const result = await storefrontSearch(shopId, { q, limit: 24, filters });
    return { q, result, error: null, metafieldKey: FACET_METAFIELD.key };
  } catch (err) {
    const error = err instanceof FilterValidationError ? err.message : "Search failed";
    return { q, result: null, error, metafieldKey: FACET_METAFIELD.key };
  }
};

// form field name for a facet key
function fieldFor(key: string, metafieldKey: string): string {
  if (key === metafieldKey) return "metafield";
  return key; // vendor | productType | tags
}

export default function SearchPlayground() {
  const { q, result, error, metafieldKey } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const applied = result?.appliedFilters;

  const isChecked = (field: string, value: string): boolean => {
    if (!applied) return false;
    const arr = (applied as any)[field] as string[] | undefined;
    return Array.isArray(arr) && arr.includes(value);
  };

  return (
    <>
      <TitleBar title="Search playground" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 980 }}>
        <h1 style={{ marginTop: 0 }}>Search &amp; filters playground</h1>
        <p style={{ color: "#555" }}>
          Test storefront search and filters for your shop. Facet counts reflect
          all other active filters — selecting an option never zeroes its own facet.
        </p>

        <Form method="get">
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              type="search" name="q" defaultValue={q} placeholder="Search products…"
              aria-label="Search query"
              style={{ flex: 1, padding: "0.5rem 0.75rem", fontSize: 16 }}
            />
            <button type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
          </div>

          {error && (
            <p style={{ background: "#fde8e8", padding: "0.6rem", borderRadius: 6 }}>⚠ {error}</p>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 20 }}>
            {/* Filter panel */}
            <aside>
              <fieldset style={{ border: "1px solid #eee", borderRadius: 8, marginBottom: 12 }}>
                <legend>Price</legend>
                <input type="number" name="priceMin" placeholder="min" defaultValue={applied?.priceMin ?? ""} style={{ width: 80 }} />
                {" – "}
                <input type="number" name="priceMax" placeholder="max" defaultValue={applied?.priceMax ?? ""} style={{ width: 80 }} />
                {result?.priceRange && (
                  <div style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
                    range: {result.priceRange.min}–{result.priceRange.max}
                  </div>
                )}
              </fieldset>

              <fieldset style={{ border: "1px solid #eee", borderRadius: 8, marginBottom: 12 }}>
                <legend>Availability</legend>
                <select name="available" defaultValue={applied?.available == null ? "" : String(applied.available)}>
                  <option value="">Any</option>
                  <option value="true">In stock</option>
                  <option value="false">Out of stock</option>
                </select>
              </fieldset>

              {(result?.facets ?? []).filter((f) => f.key !== "available").map((facet) => {
                const field = fieldFor(facet.key, metafieldKey);
                return (
                  <fieldset key={facet.key} style={{ border: "1px solid #eee", borderRadius: 8, marginBottom: 12 }}>
                    <legend>{facet.label}</legend>
                    {facet.options.map((opt) => (
                      <label key={opt.value} style={{ display: "block", fontSize: 14 }}>
                        <input type="checkbox" name={field} value={opt.value} defaultChecked={isChecked(field, opt.value)} />{" "}
                        {opt.label} <span style={{ color: "#999" }}>({opt.count})</span>
                      </label>
                    ))}
                  </fieldset>
                );
              })}
              <button type="submit" disabled={busy}>Apply filters</button>
            </aside>

            {/* Results */}
            <section>
              {result && (
                <>
                  <p style={{ color: "#555" }}>
                    <strong>{result.total}</strong> result{result.total === 1 ? "" : "s"} · strategy{" "}
                    <code>{result.strategy}</code> ·{" "}
                    {result.indexVersion != null ? `index v${result.indexVersion}` : "no index"} · {result.tookMs}ms
                    {result.fallback ? ` · fallback: ${result.fallback}` : ""}
                    {result.zeroResult ? " · zero-result" : ""}
                  </p>

                  {result.redirect && (
                    <p style={{ background: "#e5f0ff", padding: "0.75rem", borderRadius: 6 }}>
                      ↪ Redirect rule hit → <code>{result.redirect}</code> (storefront would send the shopper here)
                    </p>
                  )}

                  {result.corrected && result.correctedQuery && (
                    <p style={{ background: "#eefaf0", padding: "0.6rem", borderRadius: 6 }}>
                      Showing results for <strong>{result.correctedQuery}</strong>{" "}
                      <span style={{ color: "#888" }}>(searched for “{result.query}”)</span>
                    </p>
                  )}

                  {result.fallback === "native" && (
                    <p style={{ background: "#fff4e5", padding: "0.75rem", borderRadius: 6 }}>
                      The app could not serve results (no active index / timeout / error). The
                      storefront would fall back to the theme's native search.
                    </p>
                  )}

                  {result.products.length > 0 ? (
                    <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 10 }}>
                      {result.products.map((p) => (
                        <li key={p.id} style={{ display: "flex", gap: 12, alignItems: "center", border: "1px solid #eee", borderRadius: 8, padding: 10 }}>
                          {p.image.url ? (
                            <img src={p.image.url} alt={p.image.alt ?? p.title ?? ""} width={48} height={48} style={{ objectFit: "cover", borderRadius: 6, background: "#f6f6f6" }} />
                          ) : (
                            <div style={{ width: 48, height: 48, background: "#f6f6f6", borderRadius: 6 }} />
                          )}
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600 }}>{p.title}</div>
                            <div style={{ color: "#666", fontSize: 13 }}>
                              {p.vendor}{p.productType ? ` · ${p.productType}` : ""}
                              {p.priceMin != null ? ` · ${p.priceMin}${p.priceMax && p.priceMax !== p.priceMin ? `–${p.priceMax}` : ""}` : ""}
                              {p.available ? "" : " · out of stock"}
                            </div>
                          </div>
                          {/* Ranking explanation: why this product ranked here. */}
                          <div style={{ textAlign: "right", fontSize: 12, color: "#888", minWidth: 90 }}>
                            <div>match: <code>{p.matchClass ?? "—"}</code></div>
                            <div>score: {p.score != null ? p.score.toFixed(1) : "—"}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    !result.fallback && <p>No products matched.</p>
                  )}

                  {result.zeroResult && result.suggestions.length > 0 && (
                    <div>
                      <h3>Suggestions from your catalog</h3>
                      <ul>{result.suggestions.map((s, i) => <li key={i}>{s.text} <span style={{ color: "#999" }}>({s.type})</span></li>)}</ul>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </Form>
      </main>
    </>
  );
}
