/**
 * True Damerau-Levenshtein edit distance (Phase 5 typo tolerance).
 *
 * Implemented in TypeScript (not a SQL/C extension) deliberately — see
 * docs/PHASE5.md: candidate GENERATION is done in SQL via pg_trgm (already
 * installed, GIN-indexed on the vocabulary), but the precise edit-distance
 * SCORING (with the length-based thresholds and the tie-break rules) lives in
 * one well-tested place here. This avoids adding a new C extension
 * (fuzzystrmatch's levenshtein() is classic Levenshtein — it does NOT count a
 * transposition as a single edit) and keeps the rule logic testable in isolation.
 *
 * This is the full Lowrance-Wagner algorithm (unrestricted transpositions),
 * where an adjacent transposition ("teh" -> "the") costs exactly 1.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const maxDist = al + bl;
  const da = new Map<string, number>();
  // (al+2) x (bl+2) matrix; rows/cols 0..1 are sentinels.
  const d: number[][] = Array.from({ length: al + 2 }, () => new Array<number>(bl + 2).fill(0));
  d[0][0] = maxDist;
  for (let i = 0; i <= al; i++) {
    d[i + 1][0] = maxDist;
    d[i + 1][1] = i;
  }
  for (let j = 0; j <= bl; j++) {
    d[0][j + 1] = maxDist;
    d[1][j + 1] = j;
  }

  for (let i = 1; i <= al; i++) {
    let db = 0;
    for (let j = 1; j <= bl; j++) {
      const k = da.get(b[j - 1]) ?? 0;
      const l = db;
      let cost: number;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
        db = j;
      } else {
        cost = 1;
      }
      d[i + 1][j + 1] = Math.min(
        d[i][j] + cost, // substitution
        d[i + 1][j] + 1, // insertion
        d[i][j + 1] + 1, // deletion
        d[k][l] + (i - k - 1) + 1 + (j - l - 1), // transposition
      );
    }
    da.set(a[i - 1], i);
  }
  return d[al + 1][bl + 1];
}

/** Distance if it is <= max, else max+1 (cheap early bound on length gap). */
export function distanceWithin(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dist = damerauLevenshtein(a, b);
  return dist <= max ? dist : max + 1;
}
