import type { Exec } from "~/lib/db/executor";
import { tokenize } from "./text";

/**
 * Per-shop attribute dictionary (Phase 6.2): maps a phrase (e.g. "red",
 * "large", "cotton") onto an EXISTING filterable facet. Sensible English
 * defaults live in code; per-shop rows (search_attribute_term) add or override
 * by phrase. The parser applies the mapping through the same normalizeFilters()
 * validation as any manual filter, so nothing new reaches SQL unchecked.
 *
 * `facet` targets a Phase 4 facet group:
 *   tags | metafield (the configured material facet) | product_type | vendor.
 */
export type AttrFacet = "tags" | "metafield" | "product_type" | "vendor";
export interface AttrMapping {
  facet: AttrFacet;
  value: string;
}

function mapWords(words: string[], facet: AttrFacet): Record<string, AttrMapping> {
  const out: Record<string, AttrMapping> = {};
  for (const w of words) out[w] = { facet, value: w };
  return out;
}

const COLORS = ["red", "blue", "green", "black", "white", "yellow", "pink", "purple", "orange", "brown", "grey", "gray", "beige", "navy", "gold", "silver", "teal", "maroon"];
const SIZES = ["small", "medium", "large", "xs", "xl", "xxl", "petite", "plus size"];
const MATERIALS = ["cotton", "leather", "wool", "silk", "polyester", "denim", "linen", "suede", "nylon", "canvas", "velvet"];
const GENDER = ["mens", "womens", "kids", "unisex", "boys", "girls"];

/** Built-in English defaults. Colors/sizes/gender → tags; materials → metafield. */
export const DEFAULT_ATTRIBUTES: Record<string, AttrMapping> = {
  ...mapWords(COLORS, "tags"),
  ...mapWords(SIZES, "tags"),
  ...mapWords(GENDER, "tags"),
  ...mapWords(MATERIALS, "metafield"),
};

export interface AttributeTermRow {
  id: string;
  phrase: string;
  facet: AttrFacet;
  value: string;
}

export const MAX_ATTRIBUTE_TERMS = 2000;

function normPhrase(s: string): string {
  return tokenize(s).join(" ");
}

export async function listAttributeTerms(exec: Exec, shopId: string): Promise<AttributeTermRow[]> {
  return exec.rows<AttributeTermRow>(
    `SELECT id, phrase, facet, value FROM search_attribute_term WHERE shop_id=$1::uuid ORDER BY phrase`,
    [shopId],
  );
}

export async function addAttributeTerm(
  exec: Exec,
  shopId: string,
  phrase: string,
  facet: AttrFacet,
  value: string,
): Promise<AttributeTermRow> {
  const p = normPhrase(phrase);
  const v = value.trim();
  if (p.length === 0) throw new Error("phrase is empty");
  if (v.length === 0) throw new Error("value is empty");
  if (p.length > 100 || v.length > 100) throw new Error("phrase/value too long");
  if (!["tags", "metafield", "product_type", "vendor"].includes(facet)) throw new Error("invalid facet");
  const count = (await exec.rows<{ n: number }>(`SELECT count(*)::int AS n FROM search_attribute_term WHERE shop_id=$1::uuid`, [shopId]))[0].n;
  if (count >= MAX_ATTRIBUTE_TERMS) throw new Error(`attribute term limit reached (${MAX_ATTRIBUTE_TERMS})`);
  const rows = await exec.rows<AttributeTermRow>(
    `INSERT INTO search_attribute_term (shop_id, phrase, facet, value) VALUES ($1::uuid, $2, $3, $4)
     ON CONFLICT (shop_id, phrase) DO UPDATE SET facet=EXCLUDED.facet, value=EXCLUDED.value
     RETURNING id, phrase, facet, value`,
    [shopId, p, facet, v],
  );
  return rows[0];
}

export async function deleteAttributeTerm(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM search_attribute_term WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

/** Effective dictionary: defaults overlaid with per-shop rows (row wins by phrase). */
export async function getEffectiveAttributes(exec: Exec, shopId: string): Promise<Map<string, AttrMapping>> {
  const map = new Map<string, AttrMapping>();
  for (const [phrase, m] of Object.entries(DEFAULT_ATTRIBUTES)) map.set(phrase, m);
  for (const r of await listAttributeTerms(exec, shopId)) map.set(r.phrase, { facet: r.facet, value: r.value });
  return map;
}
