import type { Exec } from "~/lib/db/executor";
import { FACET_METAFIELD_MAPKEY } from "~/lib/search/config";
import { rebuildVocabulary } from "~/lib/search/vocabulary";
import { logger, hashShop } from "~/lib/logger.server";

/**
 * Phase 14c W1 — incremental DELTA maintenance of the per-version precomputed
 * structures (search_vocabulary, search_facet_value, search_suggest_term,
 * search_facet_summary). Instead of re-aggregating the whole visible catalog on
 * every product write (O(visible docs)), the hot incremental paths subtract the
 * changed products' OLD contributions, write the docs, then add their NEW
 * contributions — O(changed products) per write.
 *
 * Correctness model (proven by the W2 property test vs a fresh full rebuild):
 *  - A term/value row carries a count (doc_freq / doc_count). Every structure
 *    mutation is `INSERT ... ON CONFLICT DO UPDATE SET count = count + Δ`, i.e.
 *    commutative per-row arithmetic — safe under concurrency. The feeding SELECT
 *    is ORDER BY key, so concurrent writers lock rows in the same order (no
 *    deadlock). Rows that reach 0 are removed by `finalizeDelta` via a partial
 *    index on the <=0 rows (O(changed), not O(catalog)).
 *  - The facet SUMMARY doc_count is exact by +/-; the price range min/max can be
 *    extended exactly on ADD but not shrunk on REMOVE (losing the extreme needs a
 *    rescan), so removing a possible extreme sets price_dirty and the reader falls
 *    back to the live min/max until reconcile clears it.
 *
 * These helpers run inside the caller's transaction, around the doc write:
 *   subtractContributions(ids)  →  <write docs>  →  addContributions(ids)  →  finalizeDelta()
 */

// VISIBLE docs of this version restricted to the changed products.
const VIS_IDS = `psd.shop_id=$1::uuid AND psd.index_version_id=$2::uuid AND psd.published=true AND psd.status='ACTIVE' AND psd.product_id = ANY($3::uuid[])`;

async function applyVocabDelta(exec: Exec, shopId: string, versionId: string, ids: string[], sign: 1 | -1): Promise<void> {
  await exec.run(
    `INSERT INTO search_vocabulary AS sv (shop_id, index_version_id, term, doc_freq, is_numeric)
     SELECT $1::uuid, $2::uuid, d.term, ($4::int) * d.cnt, (d.term ~ '^[0-9]+$')
     FROM (
       SELECT lower(t[1]) AS term, count(DISTINCT psd.product_id)::int AS cnt
       FROM product_search_doc psd,
            LATERAL regexp_matches(immutable_unaccent(lower(psd.search_text)), '[a-z0-9]+', 'g') AS t
       WHERE ${VIS_IDS} AND char_length(lower(t[1])) >= 2
       GROUP BY lower(t[1])
     ) d
     -- Top-level ORDER BY the conflict key: concurrent writers lock the vocab
     -- rows in the same order, so overlapping updates cannot deadlock.
     ORDER BY d.term
     ON CONFLICT (shop_id, index_version_id, term) DO UPDATE SET doc_freq = sv.doc_freq + EXCLUDED.doc_freq`,
    [shopId, versionId, ids, sign],
  );
}

async function applyFacetValueDelta(exec: Exec, shopId: string, versionId: string, ids: string[], sign: 1 | -1): Promise<void> {
  await exec.run(
    `INSERT INTO search_facet_value AS fv (shop_id, index_version_id, kind, value, doc_count)
     SELECT $1::uuid, $2::uuid, d.kind, d.value, ($4::int) * d.cnt
     FROM (
       SELECT 'vendor' AS kind, psd.vendor AS value, count(*)::int AS cnt FROM product_search_doc psd
         WHERE ${VIS_IDS} AND psd.vendor IS NOT NULL AND psd.vendor <> '' GROUP BY psd.vendor
       UNION ALL
       SELECT 'product_type', psd.product_type, count(*)::int FROM product_search_doc psd
         WHERE ${VIS_IDS} AND psd.product_type IS NOT NULL AND psd.product_type <> '' GROUP BY psd.product_type
       UNION ALL
       SELECT 'tag', t, count(*)::int FROM product_search_doc psd, unnest(psd.tags) AS t
         WHERE ${VIS_IDS} AND t IS NOT NULL GROUP BY t
       UNION ALL
       SELECT 'metafield', psd.metafields->>$5, count(*)::int FROM product_search_doc psd
         WHERE ${VIS_IDS} AND psd.metafields->>$5 IS NOT NULL AND psd.metafields->>$5 <> '' GROUP BY psd.metafields->>$5
       UNION ALL
       SELECT 'available', CASE WHEN psd.available THEN 'true' ELSE 'false' END, count(*)::int FROM product_search_doc psd
         WHERE ${VIS_IDS} GROUP BY psd.available
     ) d
     ORDER BY d.kind, d.value
     ON CONFLICT (shop_id, index_version_id, kind, value) DO UPDATE SET doc_count = fv.doc_count + EXCLUDED.doc_count`,
    [shopId, versionId, ids, sign, FACET_METAFIELD_MAPKEY],
  );
}

async function applySuggestDelta(exec: Exec, shopId: string, versionId: string, ids: string[], sign: 1 | -1): Promise<void> {
  await exec.run(
    `INSERT INTO search_suggest_term AS st (shop_id, index_version_id, type, text, doc_count)
     SELECT $1::uuid, $2::uuid, d.type, d.text, ($4::int) * d.cnt
     FROM (
       SELECT 'title' AS type, psd.title AS text, count(*)::int AS cnt FROM product_search_doc psd
         WHERE ${VIS_IDS} AND psd.title IS NOT NULL AND psd.title <> '' GROUP BY psd.title
       UNION ALL
       SELECT 'vendor', psd.doc->>'vendor', count(*)::int FROM product_search_doc psd
         WHERE ${VIS_IDS} AND psd.doc->>'vendor' IS NOT NULL AND psd.doc->>'vendor' <> '' GROUP BY psd.doc->>'vendor'
       UNION ALL
       SELECT 'productType', psd.doc->>'productType', count(*)::int FROM product_search_doc psd
         WHERE ${VIS_IDS} AND psd.doc->>'productType' IS NOT NULL AND psd.doc->>'productType' <> '' GROUP BY psd.doc->>'productType'
       UNION ALL
       SELECT 'collection', ct, count(*)::int FROM product_search_doc psd, jsonb_array_elements_text(psd.doc->'collections') AS ct
         WHERE ${VIS_IDS} AND jsonb_typeof(psd.doc->'collections') = 'array' AND ct IS NOT NULL AND ct <> '' GROUP BY ct
     ) d
     ORDER BY d.type, d.text
     ON CONFLICT (shop_id, index_version_id, type, text) DO UPDATE SET doc_count = st.doc_count + EXCLUDED.doc_count`,
    [shopId, versionId, ids, sign],
  );
}

/** Summary doc_count +/- ; on subtract, dirty the price range if an extreme could drop. */
async function applySummarySubtract(exec: Exec, shopId: string, versionId: string, ids: string[]): Promise<void> {
  await exec.run(
    `WITH b AS (
       SELECT count(*)::int AS cnt, min(psd.price_min) AS mn, max(psd.price_max) AS mx
       FROM product_search_doc psd WHERE ${VIS_IDS}
     )
     UPDATE search_facet_summary s SET
       doc_count = s.doc_count - b.cnt,
       price_dirty = s.price_dirty
         OR (b.mn IS NOT NULL AND s.price_min IS NOT NULL AND b.mn <= s.price_min)
         OR (b.mx IS NOT NULL AND s.price_max IS NOT NULL AND b.mx >= s.price_max)
     FROM b WHERE s.shop_id=$1::uuid AND s.index_version_id=$2::uuid`,
    [shopId, versionId, ids],
  );
}

/** Summary doc_count + ; extend the price range (exact for additions). */
async function applySummaryAdd(exec: Exec, shopId: string, versionId: string, ids: string[]): Promise<void> {
  await exec.run(
    `WITH a AS (
       SELECT count(*)::int AS cnt, min(psd.price_min) AS mn, max(psd.price_max) AS mx
       FROM product_search_doc psd WHERE ${VIS_IDS}
     )
     UPDATE search_facet_summary s SET
       doc_count = s.doc_count + a.cnt,
       price_min = CASE WHEN a.mn IS NULL THEN s.price_min WHEN s.price_min IS NULL THEN a.mn ELSE LEAST(s.price_min, a.mn) END,
       price_max = CASE WHEN a.mx IS NULL THEN s.price_max WHEN s.price_max IS NULL THEN a.mx ELSE GREATEST(s.price_max, a.mx) END
     FROM a WHERE s.shop_id=$1::uuid AND s.index_version_id=$2::uuid`,
    [shopId, versionId, ids],
  );
}

/**
 * Serialize structure writes per (shop, version) with a transaction-scoped
 * advisory lock. The counted-row ON CONFLICT upserts are commutative, but
 * concurrent speculative inserts of the SAME new key can still deadlock in the
 * btree; a per-shop lock removes that entirely while still letting DIFFERENT
 * shops run fully in parallel (the lock key includes the shop + version). A
 * single shop's updates do not need to parallelize — they contend on the same
 * aggregate counters anyway — so this costs nothing in practice.
 */
async function lockStructures(exec: Exec, shopId: string, versionId: string): Promise<void> {
  await exec.run(`SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`, [shopId, versionId]);
}

/** Subtract the changed products' CURRENT (pre-write) visible contributions. */
export async function subtractContributions(exec: Exec, shopId: string, versionId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await lockStructures(exec, shopId, versionId);
  await applyVocabDelta(exec, shopId, versionId, ids, -1);
  await applyFacetValueDelta(exec, shopId, versionId, ids, -1);
  await applySuggestDelta(exec, shopId, versionId, ids, -1);
  await applySummarySubtract(exec, shopId, versionId, ids);
}

/** Add the changed products' NEW (post-write) visible contributions. */
export async function addContributions(exec: Exec, shopId: string, versionId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await applyVocabDelta(exec, shopId, versionId, ids, 1);
  await applyFacetValueDelta(exec, shopId, versionId, ids, 1);
  await applySuggestDelta(exec, shopId, versionId, ids, 1);
  await applySummaryAdd(exec, shopId, versionId, ids);
}

/** Remove rows whose count reached 0 (served by the partial <=0 indexes). */
export async function finalizeDelta(exec: Exec, shopId: string, versionId: string): Promise<void> {
  await exec.run(`DELETE FROM search_vocabulary WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND doc_freq <= 0`, [shopId, versionId]);
  await exec.run(`DELETE FROM search_facet_value WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND doc_count <= 0`, [shopId, versionId]);
  await exec.run(`DELETE FROM search_suggest_term WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND doc_count <= 0`, [shopId, versionId]);
}

/**
 * Phase 14c W2(c) — reconcile + drift checker. Computes an effective signature
 * of the delta-maintained structures, then does a full rebuild (which repairs
 * any drift), and compares. "Effective" means the summary price range is read
 * the way a reader would (live when price_dirty), so clearing a dirty flag is
 * NOT counted as drift — only a real divergence (e.g. a corrupted count) is.
 * On drift it logs a MASKED counter (shop id hashed, no values) and returns the
 * affected structures. Intended to run periodically in the maintenance tick.
 */
async function structureSignature(exec: Exec, shopId: string, versionId: string): Promise<Record<string, string>> {
  const p = [shopId, versionId];
  const one = async (sql: string) => (await exec.rows<{ s: string }>(sql, p))[0]?.s ?? "";
  const vocab = await one(`SELECT md5(coalesce(string_agg(term||':'||doc_freq||':'||is_numeric, ',' ORDER BY term),'')) s
    FROM search_vocabulary WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND doc_freq > 0`);
  const fv = await one(`SELECT md5(coalesce(string_agg(kind||':'||value||':'||doc_count, ',' ORDER BY kind,value),'')) s
    FROM search_facet_value WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND doc_count > 0`);
  const st = await one(`SELECT md5(coalesce(string_agg(type||':'||text||':'||doc_count, ',' ORDER BY type,text),'')) s
    FROM search_suggest_term WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND doc_count > 0`);
  // Effective summary: doc_count + live-or-stored price range.
  const srow = (await exec.rows<{ dc: number; mn: string | null; mx: string | null; dirty: boolean }>(
    `SELECT doc_count dc, price_min mn, price_max mx, price_dirty dirty FROM search_facet_summary
     WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`, p))[0];
  let summary = "";
  if (srow) {
    let mn = srow.mn, mx = srow.mx;
    if (srow.dirty) {
      const l = (await exec.rows<{ mn: string | null; mx: string | null }>(
        `SELECT min(price_min) mn, max(price_max) mx FROM product_search_doc
         WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND published AND status='ACTIVE'`, p))[0];
      mn = l?.mn ?? null; mx = l?.mx ?? null;
    }
    summary = `${srow.dc}:${mn}:${mx}`;
  }
  return { vocab, fv, st, summary };
}

export interface ReconcileResult { drifted: boolean; structures: string[] }

export async function reconcileIndexStructures(exec: Exec, shopId: string, versionId: string): Promise<ReconcileResult> {
  const before = await structureSignature(exec, shopId, versionId);
  await rebuildVocabulary(exec, shopId, versionId); // full rebuild repairs any drift
  const after = await structureSignature(exec, shopId, versionId);
  const structures = Object.keys(before).filter((k) => before[k] !== after[k]);
  if (structures.length > 0) {
    // Masked counter: hashed shop + which structures, NO values/terms.
    logger.warn({ shop: hashShop(shopId), structures, count: structures.length }, "index structure drift reconciled");
  }
  return { drifted: structures.length > 0, structures };
}

/**
 * Convenience for the incremental engine paths: subtract old contributions,
 * run the provided doc write, add new contributions, finalize. `ids` are the
 * products whose docs change; `write` performs the actual doc INSERT/DELETE.
 */
export async function withDelta(
  exec: Exec, shopId: string, versionId: string, ids: string[], write: () => Promise<void>,
): Promise<void> {
  await subtractContributions(exec, shopId, versionId, ids);
  await write();
  await addContributions(exec, shopId, versionId, ids);
  await finalizeDelta(exec, shopId, versionId);
}
