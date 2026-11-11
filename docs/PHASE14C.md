# Phase 14c — Write-path delta maintenance (design)

**Problem.** Phase 14 deferred the "incremental delta" of `search_vocabulary`
from Phase 5, and Phase 14b added two more per-version precomputed structures
(`search_facet_value` + `search_facet_summary`, `search_suggest_term`) rebuilt by
the SAME `rebuildVocabulary` call. So every product write re-aggregated the whole
visible catalog three times — O(visible docs) per write. Measured: ~1.1 s median
per update on a 10k-doc shop (17ec787), extrapolating to ~8–12 s at 100k, which
would backlog an inventory/webhook burst.

**Fix.** The hot incremental paths (`refreshDocInActiveVersion`,
`refreshDocsForProducts`) now maintain the structures by DELTA — subtract the
changed products' OLD contributions, write the docs, add the NEW contributions —
O(changed products) per write. A full rebuild stays for full builds, activation,
reindex, swap/rollback, and a periodic reconcile.

## Per-structure design

| Structure | Key + counter | Maintenance | Exact by delta? |
|---|---|---|---|
| `search_vocabulary` | (term) + `doc_freq` | per-doc token set diff; `doc_freq ± distinct-products-with-term` | **Yes** |
| `search_facet_value` | (kind, value) + `doc_count` | `doc_count ± products-with-value` (vendor/type/metafield/available = count; tags per distinct tag) | **Yes** |
| `search_suggest_term` | (type, text) + `doc_count` (added in 0025) | `doc_count ± products-contributing-term`; reads ignore the count so suggestions stay byte-identical | **Yes** |
| `search_facet_summary` | one row: `doc_count`, `price_min/max` | `doc_count ±`; price range **extended** exactly on add | **doc_count yes; price range: add-only** |

Every counted mutation is `INSERT … ON CONFLICT DO UPDATE SET count = count + Δ`
(Δ positive on add, negative on subtract) — commutative per-row arithmetic. Rows
that reach 0 are removed by `finalizeDelta`, which `DELETE … WHERE count <= 0`
served by a **partial index on the `<= 0` rows** (migration 0025), so cleanup
touches only the handful of rows that actually zeroed — O(changed), not O(catalog).

### The one structure that is NOT exactly delta-maintainable: price range
`price_min = min(price_min)` and `price_max = max(price_max)` over visible docs
can be **extended** exactly when a doc is added (take LEAST/GREATEST), but when a
doc is removed or its price moves off an extreme, the new min/max cannot be known
without a rescan. So a subtract that could drop an extreme sets `price_dirty`
(migration 0025), and the reader (`precomputedFacets`) returns the **live**
`min/max` while dirty — always exact. The reconcile job recomputes and clears the
flag. This is the sanctioned DIRTY-FLAG + live-fallback pattern; `doc_count` and
every other structure remain exact-by-delta.

## Locking (concurrency)
The ON CONFLICT upserts are commutative, but two concurrent transactions doing a
*speculative* insert of the SAME new key can still deadlock in the btree. Each
delta therefore takes a transaction-scoped **advisory lock** keyed by
`(shop_id, index_version_id)` (`pg_advisory_xact_lock(hashtext(shop),
hashtext(version))`) at the start, so a single shop's structure writes serialize
while DIFFERENT shops run fully in parallel. A shop's updates contend on the same
aggregate counters anyway, so serializing them costs nothing in practice, and it
removes deadlocks entirely (proven by the 8-way concurrency test). The feeding
SELECTs are additionally `ORDER BY` the conflict key as defence in depth.

## Reconcile + drift checker
`reconcileIndexStructures` computes an **effective** signature of the delta
tables (the 3 counted tables' rows, plus the summary's doc_count and its
effective price range — live when dirty, so clearing a dirty flag is not counted
as drift), then does a full rebuild (which repairs any drift) and compares. On a
real divergence it logs a MASKED counter (hashed shop id + which structures, no
values/terms) and reports the affected structures. It runs in the maintenance
tick (`runStructureReconcile`), BOUNDED to a few shops per tick (rotation) so the
O(catalog) rebuild cost is spread across ticks. It is a safety net: the delta is
proven correct by the property test; reconcile guarantees self-healing if a bug
or an external corruption ever drifts a row.

## Where full rebuild stays
`buildDocs` (full build), `activateIndexVersion` (new-version activation),
`reindexVersionDocs`, `rollbackToVersion` (via activation), and the periodic
reconcile. These are not per-write hot paths.

## Limits / deviations
- Price range is served live while `price_dirty` (exact but a per-browse min/max
  scan) until reconcile clears it; a write that drops the global min/max price is
  the only thing that sets it, so in practice it is rare and short-lived.
- The reconcile is a periodic O(catalog) full rebuild; it is bounded per tick and
  is a safety net, not required for correctness.
- Combined-parent doc refreshes change only the parent doc's JSON aggregate, not
  its facet/search columns, so they need no structure delta (unchanged from 14b).
