# Phase 14b Report — Fix the measured hotspots (P1–P6)

**Base:** `2e3f55f` (Phase 14) → fast-forward, existing history.
**No new** scope, npm dependency, PostgreSQL extension or SECURITY DEFINER
function (the one new helper, `immutable_lower_text_array`, is a plain IMMUTABLE
function). **New migrations:** `0022` (precomputed facet values + summary), `0023`
(rec-candidate gid/lowered-tags index + helper), `0024` (suggestion terms) —
additive + idempotent, each RLS ENABLED+FORCED with a tenant policy and
app_runtime-only grants, keyed by `index_version_id` with `ON DELETE CASCADE`.
Results stay BYTE-IDENTICAL where stated; all prior tests pass, none weakened.

> All latency numbers are from a single shared sandbox node — INDICATIVE, not
> production. Relative before/after, statement counts and EXPLAIN plans are the
> trustworthy signal. Hosted figures via the manual `benchmark.yml` workflow are
> Requires-Verification (the maintainer runs it).

## What each fix does

- **P1 — predictive skips facets.** Finding: predictive already computed NO
  facets (it uses `searchWithExec` = product query + total only; the facet GROUP
  BYs in the evidence came from the storefront search+facets cases). Added an
  explicit `facets:false` products-only option to the storefront path and a
  regression test that locks predictive to zero facet statements and proves the
  products are byte-identical with/without facets. (`phase14b-p1-predictive-facets`)
- **P2 — suggestions without a full scan.** A per-version `search_suggest_term`
  table (titles/vendors/types/version-snapshot collection titles), trigram-
  indexed on `immutable_unaccent(lower(text))`, is prefix-matched instead of
  scanning every visible doc + unnesting collections per keystroke. Used only
  when the request has no merch hide ids and combined mode is show_all (the
  dynamic, product-level exclusions can't be precomputed); otherwise the live
  per-doc scan is used. Both paths are byte-identical; draft/unpublished/
  combined-hidden never produce suggestions. (`phase14b-suggest`, 18 tests)
- **P3 — NL-parse context from a small table.** `buildParseContext` reads the
  distinct visible vendor/type/tag/metafield values from the precomputed
  `search_facet_value` table instead of four O(catalog) DISTINCT scans. Built
  from the SAME visible docs, so the value sets are identical.
- **P4 — unfiltered facets from precomputed counts.** For a landing/browse
  request (no query, no filters, no merch hide rules, combined show_all) the
  facet option counts + price range come from `search_facet_value` /
  `search_facet_summary`; any query/filter/hide/combined-hide falls back to the
  live aggregates. Parity proven on randomised catalogs (drafts, unpublished,
  out-of-stock, combined, hide rules, incremental updates, rollback); the gate
  is mutation-tested. (`phase14b-facet-precompute`, 7 tests)
- **P5 — recommendation candidates via indexes.** The candidate set is now the
  UNION of index lookups — product_type (btree), vendor (btree), case-insensitive
  tag overlap (GIN on `immutable_lower_text_array(tags)`), shared collection title
  (`product_collection`/`collection` join), and title trigram (`%`, GIN) — instead
  of scoring every visible doc. Each branch maps one-to-one onto a qualification
  rule, so the set equals the former qualifier set; the scoring + qualify filter
  + ordering are unchanged. Identical to the scan-all query on fixtures and
  randomised catalogs incl the worst case (seed shares a very large vendor+type)
  and multi-seed. (`phase14b-rec-candidates`, 5 tests)
- **P6 — measurement + EXPLAIN assertions.** EXPLAIN tests assert the
  suggestion / NL-context / facet-count reads never touch `product_search_doc`
  and the rec-candidate branches are index-usable access paths (no
  `Seq Scan on product_search_doc`), at a 10k set. (`phase14b-index-usage`, 5 tests)

### Maintenance & correctness
All three precomputed tables are rebuilt by `rebuildVocabulary` — the single
choke point every doc-writing path already calls (full build, incremental
refresh, activation catch-up, reindex). A combined-parent doc refresh rewrites
only the doc JSON aggregate (not the facet columns), so it cannot change these
values. The tables are keyed by `index_version_id` (ON DELETE CASCADE), so they
follow the atomic swap, rollback and version retention automatically. Tested:
add/remove tag, unpublish, draft, delete, rollback, cross-shop isolation,
retention cascade, equality vs the live queries on random catalogs.

## Before / after (indicative, single shared node)

### 10k products — F14 targets now PASS
| case (c1, p95 ms) | before (Phase 14) | after (14b) |
|---|---|---|
| **predictive** | 183 | **36.7** |
| **search+facets (browse)** | 85 | **21.7** |
| **typo overhead** | +74 | **−18.6** |
| nl_parsed | (via scan) | 13.4 |
| rec_similar | 233 | 133.1 |
| rec_related | 248 | 116.0 |
| search_no_filter (has query → live facets) | 88 | 77.0 |

F14 @10k: predictive **36.7 ≤ 60 PASS**, search+facets **77 ≤ 150 PASS**, typo
overhead **−18.6 ≤ 30 PASS**. (Before: predictive and typo FAILed.)

### 100k products — large reductions on the measured hotspots; absolute targets still miss on the shared node
Build: 100 000 docs in ~262 s, RSS Δ **49 MB** (still bounded — the three
precompute rebuilds add work but not unbounded memory).

| case (c1, p95 ms) | before (Phase 14) | after (14b) | change |
|---|---|---|---|
| **predictive** | 1500.9 | **189.9** | 7.9× faster |
| **browse_facets** (unfiltered) | 908.9 | **236.6** | 3.8× faster |
| **nl_parsed** | 589.0 | **163.3** | 3.6× faster |
| **rec_similar** | 2273.4 | **1264.8** | 1.8× faster |
| **rec_related** | 2227.9 | **1288.2** | 1.7× faster |
| **typo overhead** | +633.3 | **+65.6** | ~10× smaller |
| search_no_filter (query + LIVE facets) | 930.9 | 887.2 | ~unchanged (expected) |
| search_3_filters | 44 | 44.6 | ~unchanged (already fast) |

F14 targets @100k (the benchmark checks the queried `search_no_filter` case for
"search+facets"): predictive **189.9** vs ≤60 → **FAIL**; search+facets **887.2**
vs ≤250 → **FAIL**; typo overhead **+65.6** vs ≤30 → **FAIL**. Reported honestly,
**not** tuned to pass. The targets are not met in absolute terms on this shared
node, but every measured hotspot dropped sharply (predictive ~8×, browse ~4×,
rec ~1.8×, typo overhead ~10×). Note the UNFILTERED browse facet case — the one
P4 optimises — is **236.6 ms, under the 250 ms target**; the 887 ms is the
query-plus-live-facets path (a query's facets are still computed live, by
design). The residual predictive/search cost is the ranked product query itself
over 100k on shared CPU, and rec is the per-candidate scoring; both are
Requires-Verification on hosted hardware (`benchmark.yml`).

## Deviations / limitations
- Suggestions and unfiltered facets use the precompute ONLY when there are no
  per-request product-level exclusions (merch hide / combined hide); with those,
  the live path runs (identical result, original latency). This is a deliberate
  correctness boundary, not a divergence — proven byte-identical in both modes.
- The recommendation title-trigram candidate branch, like the Phase 14 tsv GIN,
  is cost-chosen as a Seq Scan by the planner on a small (10k) narrow table; it
  uses the GIN at scale. The EXPLAIN test proves every branch is an index-usable
  access path (seq scan disabled). All latency targets are sandbox-indicative.

## Verification
- `npm test`: **844 passed | 13 skipped**. `npm run test:ci-parity` (scrubbed
  env, no `.env`): **844 passed | 13 skipped** — **identical**. Up from the Phase
  14 baseline of 806/13 (+38 new 14b tests); no prior test weakened or removed.
- Gates: typecheck ✓, build ✓, worker:build ✓.
- Benchmark run at 10k and 100k (above). 2 new guards mutation-tested: the P4
  precompute gate (drop the hide check → gate test fails) and the P5 lowered-tags
  candidate branch (drop it → a tag-only-qualifier equivalence test fails).
- **Live-Prisma parity: PENDING** your GitHub Actions run.

**STATUS:** Phase 14b complete and committed on top of `2e3f55f`. The measured
hotspots are de-scanned via index-driven precompute — at 10k all three F14
targets now PASS; at 100k they still miss on shared CPU but every hotspot
dropped sharply (predictive ~8×, browse ~4×, rec ~1.8×, typo overhead ~10×),
reported with the measured numbers and not tuned to pass. All behaviour is
byte-identical (844 passed | 13 skipped, npm test == ci-parity). Live-Prisma
parity PENDING your workflow run. Awaiting explicit approval before Phase 15.
