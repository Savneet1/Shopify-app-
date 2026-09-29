import type { Exec } from "~/lib/db/executor";
import { tokenize, isFuzzable } from "./text";
import { fold, termExists, fuzzyCandidates } from "./vocabulary";
import { getEffectiveStopwords, applyStopwords } from "./stopwords";
import { listSynonyms, expandQuery } from "./synonyms";

/**
 * Query planner (Phase 5). Turns a raw query into an effective plan by:
 *   1. tokenising,
 *   2. removing stop words (unless all tokens are stop words),
 *   3. per-term typo correction (fuzzy candidates, gated by the length rules and
 *      the numeric/SKU exclusion),
 *   4. synonym expansion (query-time).
 * The plan is consumed by query.ts (products) AND facets.ts (counts) so both
 * match the SAME effective query — facets never drift under correction /
 * synonym / stop-word processing.
 *
 * Typo-distance rules (per term length, on the accent-folded token):
 *   1-3 chars  -> no fuzzy matching
 *   4-7 chars  -> distance 1
 *   8+  chars  -> distance 2
 * Numeric and code/SKU-like tokens are never fuzzy-matched. Exact matches always
 * outrank fuzzy (ranking.ts), and fuzzy is applied per term, not to the whole query.
 */

export function maxFuzzyDistance(len: number): number {
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

export interface PlanPosition {
  token: string; // folded
  candidates: string[]; // folded fuzzy candidate terms (empty if none)
}

export interface QueryPlan {
  raw: string;
  keptTokens: string[]; // folded, stop-word filtered (or all tokens if allStop)
  removedStop: string[];
  allStop: boolean;
  positions: PlanPosition[];
  corrections: Array<{ from: string; to: string }>; // top candidate per corrected term
  hasFuzzy: boolean;
  synonymExpansions: string[][]; // folded token lists
  synonymTruncated: boolean;
  isEmpty: boolean; // no tokens at all -> browse mode
}

export async function buildPlan(
  exec: Exec,
  shopId: string,
  indexVersionId: string,
  rawQuery: string,
): Promise<QueryPlan> {
  const rawTokens = tokenize(rawQuery);
  if (rawTokens.length === 0) {
    return {
      raw: rawQuery, keptTokens: [], removedStop: [], allStop: false, positions: [],
      corrections: [], hasFuzzy: false, synonymExpansions: [], synonymTruncated: false, isEmpty: true,
    };
  }

  const stop = await getEffectiveStopwords(exec, shopId);
  const { kept, removed, allStop } = applyStopwords(rawTokens, stop);

  const positions: PlanPosition[] = [];
  const corrections: Array<{ from: string; to: string }> = [];
  for (const token of kept) {
    const f = fold(token);
    if (!isFuzzable(token)) {
      positions.push({ token: f, candidates: [] });
      continue;
    }
    const maxd = maxFuzzyDistance(f.length);
    if (maxd === 0 || (await termExists(exec, shopId, indexVersionId, f))) {
      positions.push({ token: f, candidates: [] });
      continue;
    }
    const cands = await fuzzyCandidates(exec, shopId, indexVersionId, token, maxd, 5);
    positions.push({ token: f, candidates: cands.map((c) => c.term) });
    if (cands.length > 0) corrections.push({ from: f, to: cands[0].term });
  }

  const foldedKept = kept.map(fold);
  const synonyms = await listSynonyms(exec, shopId);
  const { expansions, truncated } = expandQuery(foldedKept, synonyms);
  const synonymExpansions = expansions.map((e) => e.tokens.map(fold)).filter((e) => e.length > 0);

  return {
    raw: rawQuery,
    keptTokens: foldedKept,
    removedStop: removed,
    allStop,
    positions,
    corrections,
    hasFuzzy: positions.some((p) => p.candidates.length > 0),
    synonymExpansions,
    synonymTruncated: truncated,
    isEmpty: false,
  };
}

// ---- Lexeme string builders (tokens are folded ascii alnum -> tsquery-safe) --

/** AND of tokens, e.g. "a & b". */
export function andLex(tokens: string[]): string {
  return tokens.join(" & ");
}
/** AND with the last token as a prefix, e.g. "a & b:*". */
export function prefixLex(tokens: string[]): string {
  if (tokens.length === 0) return "";
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}:*` : t)).join(" & ");
}
/** OR of tokens, e.g. "a | b". */
export function orLex(tokens: string[]): string {
  return tokens.join(" | ");
}
/** AND over positions, each position OR-ing its token with its fuzzy candidates:
 * "(a | a1 | a2) & (b)". Returns null when there is no fuzzy candidate anywhere. */
export function fuzzyLex(positions: PlanPosition[]): string | null {
  if (!positions.some((p) => p.candidates.length > 0)) return null;
  return positions
    .map((p) => {
      const alts = [p.token, ...p.candidates];
      return alts.length > 1 ? `(${alts.join(" | ")})` : p.token;
    })
    .join(" & ");
}
