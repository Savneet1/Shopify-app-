import type { Exec } from "~/lib/db/executor";
import { distanceWithin } from "./damerau";

/**
 * Per-shop, per-index-version vocabulary (surface term + document frequency),
 * used for typo tolerance (Phase 5).
 *
 * Built ONLY from VISIBLE docs (published + status ACTIVE) of the version, so a
 * correction can never surface a term that exists only on a draft/unpublished
 * product. Terms are accent-folded + lower-cased (consistent with the search
 * config's immutable_unaccent). Rebuilt after EVERY doc-writing path (full
 * build, incremental refresh, activation catch-up, collection-member refresh)
 * so it always matches the docs of its version; keyed by index_version so it
 * follows the atomic swap / rollback automatically.
 *
 * Perf note (Phase 14, not now): rebuild is a full recompute of the version's
 * vocabulary from search_text. Correctness-first; an incremental doc_freq delta
 * is a later optimisation. Documented in docs/PHASE5.md.
 */

/** JS-side accent fold for Damerau-Levenshtein comparison (matches unaccent for
 * Latin diacritics). Candidate GENERATION uses SQL immutable_unaccent. */
export function fold(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Rebuild the vocabulary for one index version from its VISIBLE docs. */
export async function rebuildVocabulary(
  exec: Exec,
  shopId: string,
  indexVersionId: string,
): Promise<number> {
  await exec.run(
    `DELETE FROM search_vocabulary WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`,
    [shopId, indexVersionId],
  );
  await exec.run(
    `INSERT INTO search_vocabulary (shop_id, index_version_id, term, doc_freq, is_numeric)
     SELECT $1::uuid, $2::uuid, term, count(DISTINCT product_id)::int AS doc_freq,
            (term ~ '^[0-9]+$') AS is_numeric
     FROM (
       SELECT psd.product_id, lower(t[1]) AS term
       FROM product_search_doc psd,
            LATERAL regexp_matches(immutable_unaccent(lower(psd.search_text)), '[a-z0-9]+', 'g') AS t
       WHERE psd.shop_id=$1::uuid AND psd.index_version_id=$2::uuid
         AND psd.published = true AND psd.status = 'ACTIVE'
     ) toks
     WHERE char_length(term) >= 2
     GROUP BY term`,
    [shopId, indexVersionId],
  );
  const rows = await exec.rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM search_vocabulary WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`,
    [shopId, indexVersionId],
  );
  return rows[0].n;
}

/** True when the (folded) term exists in the version's vocabulary. */
export async function termExists(
  exec: Exec,
  shopId: string,
  indexVersionId: string,
  foldedTerm: string,
): Promise<boolean> {
  const rows = await exec.rows(
    `SELECT 1 FROM search_vocabulary
     WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND term=$3 LIMIT 1`,
    [shopId, indexVersionId, foldedTerm],
  );
  return rows.length > 0;
}

export interface Candidate {
  term: string;
  docFreq: number;
  distance: number;
}

/**
 * Fuzzy candidates for a term, within `maxDistance`. Candidate generation is
 * pg_trgm (indexed) + a length window; precise Damerau-Levenshtein scoring is
 * done in TS. Numeric vocabulary terms are excluded. Ranking (best first):
 * higher document frequency, then smaller distance, then shared first character.
 * Returns at most `limit` candidates.
 */
export async function fuzzyCandidates(
  exec: Exec,
  shopId: string,
  indexVersionId: string,
  rawTerm: string,
  maxDistance: number,
  limit = 5,
): Promise<Candidate[]> {
  const q = fold(rawTerm);
  if (q.length === 0) return [];
  // Candidate pool via trigram similarity (GIN) + length window.
  const pool = await exec.rows<{ term: string; doc_freq: number }>(
    `SELECT term, doc_freq
     FROM search_vocabulary
     WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND is_numeric = false
       AND char_length(term) BETWEEN $4::int AND $5::int
       AND term % immutable_unaccent(lower($3))
     ORDER BY doc_freq DESC
     LIMIT 100`,
    [shopId, indexVersionId, rawTerm, Math.max(1, q.length - maxDistance), q.length + maxDistance],
  );

  const scored: Candidate[] = [];
  for (const c of pool) {
    if (c.term === q) continue; // exact is handled separately, not "fuzzy"
    const dist = distanceWithin(q, c.term, maxDistance);
    if (dist <= maxDistance) {
      scored.push({ term: c.term, docFreq: c.doc_freq, distance: dist });
    }
  }
  scored.sort(
    (a, b) =>
      b.docFreq - a.docFreq ||
      a.distance - b.distance ||
      sharedFirst(q, b.term) - sharedFirst(q, a.term) ||
      a.term.localeCompare(b.term),
  );
  return scored.slice(0, limit);
}

function sharedFirst(q: string, term: string): number {
  return q.length && term.length && q[0] === term[0] ? 1 : 0;
}
