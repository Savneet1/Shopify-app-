import type { Exec } from "~/lib/db/executor";
import { tokenize } from "./text";

/**
 * Synonyms (Phase 5.2). Per-shop, admin-managed, applied at QUERY time (no
 * reindex on change). Two kinds:
 *   - two_way : an equivalence group a ⇔ b ⇔ c (any term expands to the others)
 *   - one_way : from_term → targets (a expands to b, but not the reverse)
 * Multi-word phrases are supported (matched as contiguous token n-grams).
 *
 * Synonym-expanded matches must rank BELOW exact matches of the original term:
 * expansions are OR-branches tagged "synonym" and the ranking (ranking.ts)
 * scores that match class below exact/prefix. Hard caps: total synonyms per
 * shop, and expansions produced per query.
 */

export const MAX_SYNONYMS_PER_SHOP = 1000;
export const MAX_EXPANSIONS_PER_QUERY = 20;
export const MAX_SYNONYM_TERMS = 10; // phrases per rule

export type SynonymKind = "one_way" | "two_way";
export interface SynonymRow {
  id: string;
  kind: SynonymKind;
  from_term: string | null;
  terms: string[];
}

function normPhrase(s: string): string {
  return tokenize(s).join(" ");
}

export async function listSynonyms(exec: Exec, shopId: string): Promise<SynonymRow[]> {
  return exec.rows<SynonymRow>(
    `SELECT id, kind, from_term, terms FROM search_synonym WHERE shop_id=$1::uuid ORDER BY created_at`,
    [shopId],
  );
}

export async function addSynonym(
  exec: Exec,
  shopId: string,
  input: { kind: SynonymKind; fromTerm?: string | null; terms: string[] },
): Promise<SynonymRow> {
  const terms = (input.terms ?? []).map(normPhrase).filter((t) => t.length > 0);
  if (input.kind === "two_way") {
    if (terms.length < 2) throw new Error("two-way synonym needs at least 2 terms");
  } else {
    if (!input.fromTerm || normPhrase(input.fromTerm).length === 0) {
      throw new Error("one-way synonym needs a from-term");
    }
    if (terms.length < 1) throw new Error("one-way synonym needs at least 1 target term");
  }
  if (terms.length > MAX_SYNONYM_TERMS) throw new Error(`too many terms (max ${MAX_SYNONYM_TERMS})`);

  const count = (await exec.rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM search_synonym WHERE shop_id=$1::uuid`, [shopId],
  ))[0].n;
  if (count >= MAX_SYNONYMS_PER_SHOP) {
    throw new Error(`synonym limit reached (${MAX_SYNONYMS_PER_SHOP})`);
  }

  const fromTerm = input.kind === "one_way" ? normPhrase(input.fromTerm!) : null;
  const rows = await exec.rows<SynonymRow>(
    `INSERT INTO search_synonym (shop_id, kind, from_term, terms)
     VALUES ($1::uuid, $2, $3, $4::text[])
     RETURNING id, kind, from_term, terms`,
    [shopId, input.kind, fromTerm, terms],
  );
  return rows[0];
}

export async function deleteSynonym(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM search_synonym WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

export interface Expansion {
  tokens: string[]; // an alternative query (token list) produced by a synonym
}

/** Find a contiguous occurrence of `phraseTokens` within `tokens`; -1 if none. */
function indexOfSubsequence(tokens: string[], phraseTokens: string[]): number {
  if (phraseTokens.length === 0) return -1;
  for (let i = 0; i + phraseTokens.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/** Replace the run [start, start+len) in tokens with `replacement` tokens. */
function replaceRun(tokens: string[], start: number, len: number, replacement: string[]): string[] {
  return [...tokens.slice(0, start), ...replacement, ...tokens.slice(start + len)];
}

/**
 * Produce alternative queries (token lists) by applying synonym rules to the
 * query tokens. Each returned Expansion is a full alternative query that is
 * OR-ed into matching (tagged "synonym" by the caller). Bounded by
 * MAX_EXPANSIONS_PER_QUERY.
 */
export function expandQuery(
  tokens: string[],
  synonyms: SynonymRow[],
): { expansions: Expansion[]; truncated: boolean } {
  const out: Expansion[] = [];
  const seen = new Set<string>([tokens.join(" ")]);
  let truncated = false;

  const emit = (alt: string[]) => {
    const key = alt.join(" ");
    if (alt.length === 0 || seen.has(key)) return;
    if (out.length >= MAX_EXPANSIONS_PER_QUERY) { truncated = true; return; }
    seen.add(key);
    out.push({ tokens: alt });
  };

  for (const syn of synonyms) {
    // Build (trigger phrase -> replacement phrases) pairs for this rule.
    const pairs: Array<{ trigger: string; replacements: string[] }> = [];
    if (syn.kind === "two_way") {
      for (const t of syn.terms) {
        pairs.push({ trigger: t, replacements: syn.terms.filter((x) => x !== t) });
      }
    } else if (syn.from_term) {
      pairs.push({ trigger: syn.from_term, replacements: syn.terms });
    }
    for (const { trigger, replacements } of pairs) {
      const trigTokens = tokenize(trigger);
      const at = indexOfSubsequence(tokens, trigTokens);
      if (at < 0) continue;
      for (const rep of replacements) {
        emit(replaceRun(tokens, at, trigTokens.length, tokenize(rep)));
        if (truncated) break;
      }
    }
    if (truncated) break;
  }
  return { expansions: out, truncated };
}
