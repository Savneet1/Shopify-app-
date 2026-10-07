import type { Exec } from "~/lib/db/executor";
import { getActiveVersion } from "~/lib/index/engine";
import { tokenize } from "./text";
import { getEffectiveAttributes, type AttrMapping } from "./attributes";
import { FACET_METAFIELD_MAPKEY } from "./config";
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
  /** Live, visible tag values keyed by lower-case → original live casing (A2). */
  tagValues: Map<string, string>;
  /** Live, visible configured-metafield values, lower-case → live casing (A2). */
  metafieldValues: Map<string, string>;
}

/** Build a case-insensitive lookup (lower-case → live casing). Deterministic:
 * when two live values collide case-insensitively, the lexicographically first
 * original casing wins. */
function ciMap(values: string[]): Map<string, string> {
  const sorted = [...values].sort((a, b) => a.localeCompare(b));
  const m = new Map<string, string>();
  for (const v of sorted) {
    const k = v.toLowerCase();
    if (!m.has(k)) m.set(k, v);
  }
  return m;
}

export interface ParseOptions {
  ignore?: Set<InterpretKind>;
}

const NEGATIONS = new Set(["not", "no", "without", "except", "excluding", "sans"]);
const MAX_PARSE_LEN = 200;

// --- Price parsing (Phase 6.1 A1) ---------------------------------------------
// A money amount: optional currency symbol, an integer (plain or with thousands
// commas), an optional decimal, and an optional trailing currency word. The
// amount is validated (≤9 integer digits, ≤2 decimals) AFTER matching so an
// over-long number is rejected whole rather than partially consumed.
const CURWORD = String.raw`(?:dollars?|usd|rs\.?|inr|rupees?|pounds?|gbp|euros?|eur)`;
const AMT = String.raw`((?:[$£€₹]\s?)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?${CURWORD})?)`;

// Unit/count words that mean a number is NOT a price.
const UNIT_WORDS = new Set([
  "ml", "l", "oz", "kg", "g", "lb", "mm", "cm", "m", "inch", "in", "gb", "tb",
  "pack", "pcs", "piece", "pieces", "color", "colors", "star", "stars",
  "year", "years", "yr",
]);
// A unit attached with no space ("100ml", "18s", "5kg").
const NOSPACE_UNIT = /^(?:ml|l|oz|kg|g|lb|mm|cm|m|inch|in|gb|tb|yr|s)(?![a-z0-9])/i;

interface Amount { value: number; hadCurrency: boolean; }
function amountInfo(raw: string): Amount | null {
  const hadCurrency = /[$£€₹]/.test(raw) || new RegExp(CURWORD, "i").test(raw);
  const m = raw.match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const intPart = m[1].replace(/,/g, "");
  const decPart = m[2] ?? "";
  if (intPart.length > 9 || decPart.length > 2) return null; // reject, don't truncate
  const value = Number(intPart + (decPart ? "." + decPart : ""));
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) return null;
  return { value, hadCurrency };
}

/** True when the text right after the number means it is NOT a price. */
function notAPrice(rest: string, value: number, hadCurrency: boolean, ambiguous: boolean): boolean {
  if (NOSPACE_UNIT.test(rest)) return true; // "100ml", "18s"
  const sp = rest.match(/^\s+(\p{L}+)/u);
  if (sp && UNIT_WORDS.has(sp[1].toLowerCase())) return true; // "2 colors", "100 ml"
  // Ambiguous cues (from/over/above/at least/more than/up to) without a currency
  // marker do not apply to a plausible year.
  if (ambiguous && !hadCurrency && Number.isInteger(value) && value >= 1900 && value <= 2100) return true;
  return false;
}

interface PriceHit { priceMin?: number; priceMax?: number; text: string; detail: string; }

/** Extract ONE price constraint from `s`, or null. Leaves `s` untouched when a
 * cue matches but the number is invalid or looks like a year/unit/count. */
function extractPrice(s: string): { hit: PriceHit; newS: string } | null {
  const tryCue = (
    re: RegExp, build: (a: Amount, b?: Amount) => PriceHit, ambiguous: boolean, two = false,
  ): { hit: PriceHit; newS: string } | null => {
    const m = re.exec(s);
    if (!m) return null;
    const a = amountInfo(m[1]);
    if (!a) return null;
    const b = two ? amountInfo(m[2]) : undefined;
    if (two && !b) return null;
    const after = s.slice(m.index + m[0].length);
    const last = two ? b! : a;
    if (notAPrice(after, last.value, last.hadCurrency, ambiguous)) return null;
    return { hit: build(a, b ?? undefined), newS: s.replace(m[0], " ") };
  };

  return (
    tryCue(new RegExp(String.raw`\bbetween\s+${AMT}\s*(?:and|to|-|–|—)\s*${AMT}`, "i"),
      (a, b) => { const lo = Math.min(a.value, b!.value), hi = Math.max(a.value, b!.value); return { priceMin: lo, priceMax: hi, text: "between", detail: `price ${lo}–${hi}` }; }, false, true)
    ?? tryCue(new RegExp(String.raw`(?:\baround\b\s*|\babout\b\s*|\bapproximately\b\s*|~\s*)${AMT}`, "i"),
      (a) => { const lo = Math.round(a.value * 0.8 * 100) / 100, hi = Math.round(a.value * 1.2 * 100) / 100; return { priceMin: lo, priceMax: hi, text: "around", detail: `price ~${a.value} (${lo}–${hi})` }; }, false)
    ?? tryCue(new RegExp(String.raw`\b(?:under|below|less than|cheaper than|at most)\s+${AMT}`, "i"),
      (a) => ({ priceMax: a.value, text: "max", detail: `price ≤ ${a.value}` }), false)
    ?? tryCue(new RegExp(String.raw`\bup to\s+${AMT}`, "i"),
      (a) => ({ priceMax: a.value, text: "max", detail: `price ≤ ${a.value}` }), true)
    ?? tryCue(new RegExp(String.raw`\b(?:over|above|more than|at least|starting at|from)\s+${AMT}`, "i"),
      (a) => ({ priceMin: a.value, text: "min", detail: `price ≥ ${a.value}` }), true)
  );
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
  // A2: live, VISIBLE tag + configured-metafield values (same visibility as
  // vendor/product_type above), so attribute phrases resolve case-insensitively
  // to the actual live casing and never leak a draft-only value.
  const tagValues = (
    await exec.rows<{ v: string }>(
      `SELECT DISTINCT unnest(tags) AS v FROM product_search_doc
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'`,
      [shopId, versionId],
    )
  ).map((r) => r.v).filter((v) => v != null && v !== "");
  const metafieldValues = (
    await exec.rows<{ v: string }>(
      `SELECT DISTINCT metafields->>$3 AS v FROM product_search_doc
       WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published=true AND status='ACTIVE'
         AND metafields->>$3 IS NOT NULL AND metafields->>$3 <> ''`,
      [shopId, versionId, FACET_METAFIELD_MAPKEY],
    )
  ).map((r) => r.v);
  return {
    attributes,
    vendors,
    productTypes,
    tagValues: ciMap(tagValues),
    metafieldValues: ciMap(metafieldValues),
  };
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

  // --- 1) Price (Phase 6.1 A1) ---
  // Iterate so a query can carry e.g. a min AND a max; each pass removes the
  // matched phrase. Invalid/ambiguous numbers leave `s` untouched (no partial
  // consumption, text unchanged).
  if (!ignore.has("price")) {
    for (let pass = 0; pass < 3; pass++) {
      const pr = extractPrice(s);
      if (!pr) break;
      if (pr.hit.priceMin != null && filters.priceMin == null) filters.priceMin = pr.hit.priceMin;
      if (pr.hit.priceMax != null && filters.priceMax == null) filters.priceMax = pr.hit.priceMax;
      interpreted.push({ kind: "price", text: pr.hit.text, detail: pr.hit.detail });
      s = pr.newS;
    }
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

  // Apply one matched entry. Returns false (do NOT consume) when a tag/metafield
  // attribute value does not resolve to a LIVE visible facet value — it then
  // stays free text (A2). Vendor/product_type matches already come from live
  // facet values, so they always apply.
  const applyEntry = (e: PhraseEntry): boolean => {
    if (e.source === "vendor") { vendorArr.push(e.original); interpreted.push({ kind: "vendor", text: e.tokens.join(" "), detail: `vendor = ${e.original}` }); return true; }
    if (e.source === "product_type") { typeArr.push(e.original); interpreted.push({ kind: "product_type", text: e.tokens.join(" "), detail: `product type = ${e.original}` }); return true; }
    const mp = e.mapping!;
    if (mp.facet === "tags") {
      const live = ctx.tagValues.get(mp.value.toLowerCase());
      if (!live) return false; // no matching live tag value → stays free text
      tagsArr.push(live);
      interpreted.push({ kind: "attribute", text: e.tokens.join(" "), detail: `tags = ${live}` });
      return true;
    }
    if (mp.facet === "metafield") {
      const live = ctx.metafieldValues.get(mp.value.toLowerCase());
      if (!live) return false;
      metaArr.push(live);
      interpreted.push({ kind: "attribute", text: e.tokens.join(" "), detail: `metafield = ${live}` });
      return true;
    }
    if (mp.facet === "product_type") typeArr.push(mp.value);
    else if (mp.facet === "vendor") vendorArr.push(mp.value);
    interpreted.push({ kind: "attribute", text: e.tokens.join(" "), detail: `${mp.facet} = ${mp.value}` });
    return true;
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
    if (negated) {
      // Negation recognised at the dictionary level (independent of live
      // resolution): consume term + marker, flag it, never apply (A3).
      for (let j = 0; j < matched.tokens.length; j++) consumed[i + j] = true;
      consumed[i - 1] = true;
      negations.push(matched.tokens.join(" "));
      i += matched.tokens.length - 1;
      continue;
    }
    if (applyEntry(matched)) {
      for (let j = 0; j < matched.tokens.length; j++) consumed[i + j] = true;
      i += matched.tokens.length - 1;
    }
    // else: unresolved tag/metafield attribute → leave tokens as free text.
  }

  if (vendorArr.length) filters.vendor = vendorArr;
  if (typeArr.length) filters.productType = typeArr;
  if (tagsArr.length) filters.tags = tagsArr;
  if (metaArr.length) filters.metafield = metaArr;

  const remaining = tokens.filter((_, i) => !consumed[i]).join(" ").trim();
  return { filters, sort, remaining, interpreted, negations };
}
