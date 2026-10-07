import type { Exec } from "~/lib/db/executor";
import { getActiveVersion } from "~/lib/index/engine";
import { tokenize } from "./text";
import { getEffectiveAttributes, type AttrMapping } from "./attributes";
import type { RawFilters } from "./filters";
import type { SortOption } from "./query";

/**
 * Rule-based natural-language query parser (Phase 6). Deterministic, no ML.
 * Extracts price / availability / sort / brand / product-type / attribute intent
 * from a query and returns the remaining free text, plus a transparent
 * "interpreted as" trace. The extracted filters are merged into the EXISTING
 * RawFilters and the remaining text feeds the EXISTING Phase 5 planner, so
 * results and facet counts use the same code path (no drift).
 *
 * Negation ("not red", "without leather"): detected and the negated attribute is
 * DROPPED (not applied as a positive filter, and not left as free text). Negative
 * FILTERING (exclude red) is intentionally unsupported — see docs/PHASE6.md — and
 * degrades safely (never searches for the thing the user said to exclude).
 */

export type InterpretKind = "price" | "availability" | "sort" | "vendor" | "product_type" | "attribute";
export interface InterpretedItem {
  kind: InterpretKind;
  text: string; // the matched phrase
  detail: string; // human-readable effect
}
export interface ParsedIntent {
  filters: RawFilters;
  sort?: SortOption;
  remaining: string;
  interpreted: InterpretedItem[];
  negations: string[];
}

export interface ParseContext {
  attributes: Map<string, AttrMapping>;
  vendors: string[];
  productTypes: string[];
}

export interface ParseOptions {
  ignore?: Set<InterpretKind>;
}

const NEGATIONS = new Set(["not", "no", "without", "except", "excluding", "sans"]);
const MAX_PARSE_LEN = 200;

// Number with optional leading currency symbol and optional trailing currency word.
const NUM = String.raw`(?:[$£€₹]\s*)?(\d{1,7}(?:\.\d{1,2})?)(?:\s*(?:dollars?|usd|rs\.?|inr|rupees?|pounds?|gbp|euros?|eur))?`;

function toNum(s: string): number | null {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000_000 ? n : null;
}

/** Build the per-shop parse context (attributes + live vendor/type values). */
export async function buildParseContext(exec: Exec, shopId: string, versionId: string): Promise<ParseContext> {
  const attributes = await getEffectiveAttributes(exec, shopId);
  const vendors = (
    await exec.rows<{ v: string }>(
      `SELECT DISTINCT vendor AS v FROM product_search_doc
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'
         AND vendor IS NOT NULL AND vendor <> ''`,
      [shopId, versionId],
    )
  ).map((r) => r.v);
  const productTypes = (
    await exec.rows<{ v: string }>(
      `SELECT DISTINCT product_type AS v FROM product_search_doc
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'
         AND product_type IS NOT NULL AND product_type <> ''`,
      [shopId, versionId],
    )
  ).map((r) => r.v);
  return { attributes, vendors, productTypes };
}

interface PhraseEntry {
  tokens: string[];
  source: "vendor" | "product_type" | "attribute";
  original: string; // value to apply (vendor/type: original-case value; attribute: mapping value)
  mapping?: AttrMapping;
}

/** Deterministic pure parser. */
export function parseQuery(rawQuery: string, ctx: ParseContext, opts: ParseOptions = {}): ParsedIntent {
  const ignore = opts.ignore ?? new Set<InterpretKind>();
  const filters: RawFilters = {};
  const interpreted: InterpretedItem[] = [];
  const negations: string[] = [];
  let sort: SortOption | undefined;

  let s = " " + String(rawQuery ?? "").slice(0, MAX_PARSE_LEN).toLowerCase() + " ";

  const pushPrice = (min: number | null, max: number | null, text: string, detail: string) => {
    if (min != null) filters.priceMin = min;
    if (max != null) filters.priceMax = max;
    interpreted.push({ kind: "price", text, detail });
  };

  // --- 1) Price ---
  if (!ignore.has("price")) {
    const between = new RegExp(String.raw`\bbetween\s+${NUM}\s+(?:and|to|-|–|—)\s+${NUM}`, "i");
    let m = s.match(between);
    if (m) { const a = toNum(m[1]); const b = toNum(m[2]); if (a != null && b != null) { pushPrice(Math.min(a, b), Math.max(a, b), m[0].trim(), `price ${Math.min(a, b)}–${Math.max(a, b)}`); s = s.replace(m[0], " "); } }

    const under = new RegExp(String.raw`\b(?:under|below|less than|cheaper than|up to|at most)\s+${NUM}`, "i");
    m = s.match(under);
    if (m) { const v = toNum(m[1]); if (v != null) { pushPrice(null, v, m[0].trim(), `price ≤ ${v}`); s = s.replace(m[0], " "); } }

    const over = new RegExp(String.raw`\b(?:over|above|more than|at least|starting at|from)\s+${NUM}`, "i");
    m = s.match(over);
    if (m) { const v = toNum(m[1]); if (v != null) { pushPrice(v, null, m[0].trim(), `price ≥ ${v}`); s = s.replace(m[0], " "); } }

    const around = new RegExp(String.raw`\b(?:around|about|approximately|~)\s*${NUM}`, "i");
    m = s.match(around);
    if (m) { const v = toNum(m[1]); if (v != null) { const lo = Math.round(v * 0.8 * 100) / 100; const hi = Math.round(v * 1.2 * 100) / 100; pushPrice(lo, hi, m[0].trim(), `price ~${v} (${lo}–${hi})`); s = s.replace(m[0], " "); } }
  }

  // --- 2) Availability (check out-of-stock first) ---
  if (!ignore.has("availability")) {
    if (/\b(out of stock|sold out|unavailable|out-of-stock)\b/i.test(s)) {
      filters.available = "false"; interpreted.push({ kind: "availability", text: "out of stock", detail: "availability = out of stock" });
      s = s.replace(/\b(out of stock|sold out|unavailable|out-of-stock)\b/gi, " ");
    } else if (/\b(in stock|in-stock|available)\b/i.test(s)) {
      filters.available = "true"; interpreted.push({ kind: "availability", text: "in stock", detail: "availability = in stock" });
      s = s.replace(/\b(in stock|in-stock|available)\b/gi, " ");
    }
  }

  // --- 3) Sort hints ---
  if (!ignore.has("sort")) {
    const sortRules: Array<[RegExp, SortOption, string]> = [
      [/\b(cheapest|lowest price|least expensive|cheap)\b/i, "price_asc", "sort by price (low→high)"],
      [/\b(most expensive|highest price|priciest|dearest)\b/i, "price_desc", "sort by price (high→low)"],
      [/\b(newest|latest|new arrivals?|most recent)\b/i, "newest", "sort by newest"],
    ];
    for (const [re, opt, detail] of sortRules) {
      const m = s.match(re);
      if (m) { sort = opt; interpreted.push({ kind: "sort", text: m[0].trim(), detail }); s = s.replace(re, " "); break; }
    }
  }

  // --- 4) Brand / product-type / attribute (token scan, negation-aware) ---
  const tokens = tokenize(s);
  const consumed = new Array(tokens.length).fill(false);

  const entries: PhraseEntry[] = [];
  if (!ignore.has("vendor")) for (const v of ctx.vendors) { const t = tokenize(v); if (t.length) entries.push({ tokens: t, source: "vendor", original: v }); }
  if (!ignore.has("product_type")) for (const v of ctx.productTypes) { const t = tokenize(v); if (t.length) entries.push({ tokens: t, source: "product_type", original: v }); }
  if (!ignore.has("attribute")) for (const [phrase, mapping] of ctx.attributes) { const t = tokenize(phrase); if (t.length) entries.push({ tokens: t, source: "attribute", original: mapping.value, mapping }); }

  // Longest phrase first; stable tie-break by source priority then text.
  const sourceRank = { vendor: 0, product_type: 1, attribute: 2 } as const;
  entries.sort((a, b) => b.tokens.length - a.tokens.length || sourceRank[a.source] - sourceRank[b.source] || a.tokens.join(" ").localeCompare(b.tokens.join(" ")));

  const vendorArr: string[] = [];
  const typeArr: string[] = [];
  const tagsArr: string[] = [];
  const metaArr: string[] = [];

  const applyEntry = (e: PhraseEntry) => {
    if (e.source === "vendor") { vendorArr.push(e.original); interpreted.push({ kind: "vendor", text: e.tokens.join(" "), detail: `vendor = ${e.original}` }); return; }
    if (e.source === "product_type") { typeArr.push(e.original); interpreted.push({ kind: "product_type", text: e.tokens.join(" "), detail: `product type = ${e.original}` }); return; }
    const mp = e.mapping!;
    if (mp.facet === "tags") tagsArr.push(mp.value);
    else if (mp.facet === "metafield") metaArr.push(mp.value);
    else if (mp.facet === "product_type") typeArr.push(mp.value);
    else if (mp.facet === "vendor") vendorArr.push(mp.value);
    interpreted.push({ kind: "attribute", text: e.tokens.join(" "), detail: `${mp.facet} = ${mp.value}` });
  };

  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    let matched: PhraseEntry | null = null;
    for (const e of entries) {
      if (i + e.tokens.length > tokens.length) continue;
      let ok = true;
      for (let j = 0; j < e.tokens.length; j++) { if (consumed[i + j] || tokens[i + j] !== e.tokens[j]) { ok = false; break; } }
      if (ok) { matched = e; break; }
    }
    if (!matched) continue;
    const negated = i > 0 && NEGATIONS.has(tokens[i - 1]);
    for (let j = 0; j < matched.tokens.length; j++) consumed[i + j] = true;
    if (negated) {
      consumed[i - 1] = true; // consume the negation marker too
      negations.push(matched.tokens.join(" "));
    } else {
      applyEntry(matched);
    }
    i += matched.tokens.length - 1;
  }

  if (vendorArr.length) filters.vendor = vendorArr;
  if (typeArr.length) filters.productType = typeArr;
  if (tagsArr.length) filters.tags = tagsArr;
  if (metaArr.length) filters.metafield = metaArr;

  const remaining = tokens.filter((_, i) => !consumed[i]).join(" ").trim();
  return { filters, sort, remaining, interpreted, negations };
}
