# Phase 14c Report — Write-path delta maintenance (W1–W3)

**Base:** `17ec787` (Phase 14b) → fast-forward, existing history.
**No new** scope, npm dependency, PostgreSQL extension or SECURITY DEFINER
function. **New migration:** `0025` (suggest-term `doc_count` refcount, summary
`price_dirty`, partial `<=0` cleanup indexes) — additive + idempotent, RLS on the
existing tables unchanged. READ results stay byte-identical. Design per structure
in `docs/PHASE14C.md`.

## Decisions
- **W1 delta maintenance.** The hot incremental paths (`refreshDocInActiveVersion`,
  `refreshDocsForProducts`) now subtract the changed products' OLD contributions,
  write the docs, then add their NEW contributions — O(changed) per write, one
  statement per structure. `search_vocabulary` (doc_freq), `search_facet_value`
  (doc_count) and `search_suggest_term` (new doc_count refcount) are exact by
  delta; the facet `search_facet_summary` doc_count is exact and its price range
  is extended exactly on add and DIRTY-FLAGGED when an extreme could drop (reader
  falls back to the live, exact min/max until reconcile clears it). Full rebuild
  stays for full builds, activation, reindex, swap/rollback and a periodic
  reconcile. Zeroed rows are cleaned via partial `<=0` indexes (O(changed)).
- **Locking.** A transaction-scoped advisory lock per `(shop, version)`
  serializes a shop's structure writes (different shops stay parallel), removing
  ON CONFLICT speculative-insert deadlocks; feeding SELECTs also `ORDER BY` the
  key as defence in depth.
- **Reconcile + drift checker** (`reconcileIndexStructures`) runs in the
  maintenance tick (bounded rotation), full-rebuilds to repair any drift, and
  logs a masked counter on a real (effective) divergence.

## Correctness (W2)
- **(a) Property test** — after 250 random ops through the REAL apply paths, all
  delta tables are EXACTLY equal to a fresh full rebuild (row-for-row for the 3
  counted tables; doc_count + effective price range for the summary).
- **(b) Concurrency** — 8 parallel writers over overlapping vendors/tags/titles
  finish equal to a full rebuild with NO deadlock (per-shop advisory lock).
- **(c) Drift checker** — deliberately corrupting a row is DETECTED (masked log +
  reported structures) and REPAIRED; a correctly maintained version reports no
  drift.
- **(d) Read equivalence** — search (filtered + unfiltered browse), predictive,
  suggestions, NL parsing, facets and recommendations are identical to a fresh
  rebuild across states: load, incremental updates, delete, rollback (timing
  fields excluded).
- **(e) Mutation testing** — breaking a decrement makes the property test fail;
  breaking the price-dirty fallback makes the dirty-fallback read test fail.

## W3 — write-path measurement (SANDBOX, single shared node — INDICATIVE)
Per-update latency through the real `applyProductUpsert` webhook path.

### 10k docs
| metric | before (17ec787, full rebuild) | after (14c delta) |
|---|---|---|
| **per-update p50** | **1231 ms** | **15.6 ms** (~79× faster) |
| per-update p95 | 1531 ms | 21.5 ms |
| per-update max | 1761 ms | 37.8 ms |
| statements / update | — | 21 |
| 2,000-update burst drain | ~41 min (2000 × ~1.23 s) | **33.5 s** (p50 16 ms, p95 22 ms) |

The "before" full-rebuild figure (1231 ms p50) matches the maintainer's own
measurement (~1,127–1,154 ms median on 17ec787). **write_update p50 15.6 ms ≤
100 ms target → PASS.**

### 100k docs
| metric | before (17ec787, full rebuild) | after (14c delta) |
|---|---|---|
| **per-update p50** | **10 428 ms** | **30.9 ms** (~337× faster) |
| per-update p95 | 10 832 ms | 43.6 ms |
| statements / update | — | 21 |
| 1,500-update burst drain | ~4.3 h (1500 × ~10.4 s) | **30.9 s** (p50 20 ms, p95 29 ms) |

The "before" full-rebuild figure (10.4 s p50) matches the maintainer's extrapolation
(~8–12 s at 100k). write_update p50 30.9 ms ≤ 100 ms.

### Target: per-update p50 ≤ 100 ms @10k, growth 10k→100k ≤ ~2×
| | 10k | 100k | growth |
|---|---|---|---|
| write_update p50 (after) | 15.6 ms | 30.9 ms | **1.98×** |
| before (full rebuild) | 1 231 ms | 10 428 ms | 8.5× |
| speed-up | **79×** | **337×** | |

**PASS**: per-update p50 15.6 ms ≤ 100 ms @10k, and growth 10k→100k is **1.98×**,
just within the ≤ ~2× target. The mild size dependence is the larger btree/GIN
inserts and the per-doc token extraction, not catalog-sized re-aggregation — the
old full rebuild grew 8.5× over the same range. All figures are sandbox-
indicative; hosted numbers via `benchmark.yml` are Requires-Verification.

## Deviations / limitations
- Price range reads live while `price_dirty` (exact but a per-browse min/max scan)
  until the reconcile clears it; only a write that drops the global min/max price
  sets it, so it is rare and short-lived.
- Reconcile is a periodic O(catalog) full rebuild, bounded per tick; a safety net,
  not required for correctness (the delta is proven exact by the property test).
- Replay/out-of-order safety is unchanged: the monotonic upsert guard still
  governs doc content, and the delta is computed from the doc's committed
  before/after state, so a skipped (stale) replay yields a zero net delta.

## Verification
- `npm test`: **850 passed | 13 skipped** (88 files). `npm run test:ci-parity`:
  **850 passed | 13 skipped** (88 files) — identical. That is the Phase 14b
  baseline (844 passed | 13 skipped) plus the 6 new Phase 14c tests, none
  weakened.
- Gates: typecheck ✓, build ✓, worker:build ✓.
- Benchmark run at 10k and 100k (write_update + write_burst added to the harness
  and the manual `benchmark.yml`).
- **Live-Prisma parity: PENDING** your GitHub Actions run.

**STATUS:** Phase 14c COMPLETE — write-path full-rebuild replaced by O(changed)
delta maintenance (migration 0025, advisory-locked, reconcile+drift net, price
dirty-flag live fallback); reads byte-identical (850 passed | 13 skipped, npm test
== ci-parity; property / 8-way concurrency / drift / read-equivalence / 2 mutation
guards all green); typecheck+build+worker:build ✓; write_update p50 1231→15.6 ms
@10k (79×) and 10 428→30.9 ms @100k (337×), growth 1.98× ≤ ~2× → PASS. Live-Prisma
parity PENDING your GitHub Actions run. STOP — awaiting explicit approval before
Phase 15.
