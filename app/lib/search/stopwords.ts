import type { Exec } from "~/lib/db/executor";

/**
 * Stop words (Phase 5.3). A default English list plus per-shop add/remove
 * overrides. Effective set = (defaults − removed) ∪ added.
 *
 * Stop words are ignored in matching ONLY when at least one non-stop term
 * remains; a query made entirely of stop words still searches (using all its
 * terms). The SAME effective set is applied to search, predictive and facet
 * counting (the query planner runs once and feeds all three).
 */
export const DEFAULT_STOPWORDS: readonly string[] = [
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
  "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
  "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
];

export type StopwordMode = "add" | "remove";
export interface StopwordRow {
  id: string;
  word: string;
  mode: StopwordMode;
}

export const MAX_STOPWORD_OVERRIDES = 500;

function norm(word: string): string {
  return word.trim().toLowerCase();
}

export async function listStopwords(exec: Exec, shopId: string): Promise<StopwordRow[]> {
  return exec.rows<StopwordRow>(
    `SELECT id, word, mode FROM search_stopword WHERE shop_id=$1::uuid ORDER BY word`,
    [shopId],
  );
}

export async function addStopwordOverride(
  exec: Exec,
  shopId: string,
  word: string,
  mode: StopwordMode,
): Promise<StopwordRow> {
  const w = norm(word);
  if (w.length === 0) throw new Error("stopword cannot be empty");
  if (w.length > 100) throw new Error("stopword too long");
  const count = (await exec.rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM search_stopword WHERE shop_id=$1::uuid`, [shopId],
  ))[0].n;
  if (count >= MAX_STOPWORD_OVERRIDES) {
    throw new Error(`stopword override limit reached (${MAX_STOPWORD_OVERRIDES})`);
  }
  const rows = await exec.rows<StopwordRow>(
    `INSERT INTO search_stopword (shop_id, word, mode) VALUES ($1::uuid, $2, $3)
     ON CONFLICT (shop_id, word) DO UPDATE SET mode=EXCLUDED.mode
     RETURNING id, word, mode`,
    [shopId, w, mode],
  );
  return rows[0];
}

export async function deleteStopwordOverride(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM search_stopword WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

/** Compute the effective stop-word set for a shop. */
export async function getEffectiveStopwords(exec: Exec, shopId: string): Promise<Set<string>> {
  const rows = await listStopwords(exec, shopId);
  const set = new Set<string>(DEFAULT_STOPWORDS);
  for (const r of rows) {
    if (r.mode === "add") set.add(r.word);
    else if (r.mode === "remove") set.delete(r.word);
  }
  return set;
}

/**
 * Drop stop words from a token list, UNLESS every token is a stop word (then
 * keep them all so the query still works). Returns kept + removed tokens.
 */
export function applyStopwords(
  tokens: string[],
  stop: Set<string>,
): { kept: string[]; removed: string[]; allStop: boolean } {
  const kept = tokens.filter((t) => !stop.has(t));
  if (kept.length === 0 && tokens.length > 0) {
    return { kept: [...tokens], removed: [], allStop: true };
  }
  const removed = tokens.filter((t) => stop.has(t));
  return { kept, removed, allStop: false };
}
