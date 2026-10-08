import type { LoaderFunctionArgs } from "react-router";
import { handleProxy } from "~/lib/search/proxy.server";
import { storefrontSearch } from "~/lib/search/storefront";
import { filtersFromSearchParams } from "~/lib/search/params";
import { normalizeSort } from "~/lib/search/query";
import type { InterpretKind } from "~/lib/search/nlparse";

/**
 * Storefront search + filters + NL endpoint (App Proxy).
 * Storefront URL: /apps/<subpath>/products?q=...&vendor=...&sort=...&nl=0&ignore=price
 * Proxied to:     /proxy/products
 *
 * JSON only. Shop identity is signature-verified (see handleProxy). Returns the
 * Phase 5 payload plus `sort` and an `interpretedAs` block (Phase 6). NL parsing
 * is ON by default; `nl=0`/`nl=false` disables it, and `ignore=price,vendor`
 * drops individual interpretations. Malformed filters -> 400 (handleProxy).
 */
const VALID_IGNORE: InterpretKind[] = ["price", "availability", "sort", "vendor", "product_type", "attribute"];

export const loader = async ({ request }: LoaderFunctionArgs) =>
  handleProxy(request, ({ shopId, url }) => {
    const sp = url.searchParams;
    const nlRaw = sp.get("nl");
    const nl = !(nlRaw === "0" || nlRaw === "false"); // on by default
    const ignore = (sp.get("ignore") ?? "")
      .split(",").map((s) => s.trim())
      .filter((s): s is InterpretKind => (VALID_IGNORE as string[]).includes(s));
    return storefrontSearch(shopId, {
      q: sp.get("q") ?? "",
      limit: numParam(sp.get("limit")),
      offset: numParam(sp.get("offset")),
      filters: filtersFromSearchParams(sp),
      sort: sp.get("sort") != null ? normalizeSort(sp.get("sort")) : undefined,
      nl,
      ignore,
      visitorToken: sp.get("abt"), // Phase 8: anonymous A/B token (no PII)
    });
  });

function numParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
