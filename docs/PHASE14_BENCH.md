# Phase 14 — Benchmark results

**Run:** 2026-11-10T12:46:04.359Z · size **100000** products · seed 1337 · N=40 · concurrency 1.

> **Indicative numbers — single shared sandbox node, not production.** Absolute latency on a shared container is not representative; use the hosted `benchmark.yml` workflow for comparable figures. Relative comparisons (before/after, per-query, statement counts) and the EXPLAIN plans are meaningful here.

## Machine

- Cores: 2 · RAM: 8.41 GB · linux · Node v22.22.0
- PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) · shared_buffers=128MB · work_mem=4MB · effective_cache_size=4GB

## Build (real sync→index path)

- 100000 docs in **261698.25 ms**, RSS Δ 49 MB.
- Dataset: {"active":92359,"draft":4734,"archived":2907,"unpublished":7059,"unavailable":8017,"combinedParents":1653,"combinedChildren":4923,"variants":295482,"collections":200}

## Query latency (ms) and statements/request

| case | conc | p50 | p95 | p99 | stmts (p50) |
|---|---|---|---|---|---|
| predictive | 1 | 159.31 | 189.93 | 193.49 | 14 |
| search_no_filter | 1 | 730.97 | 887.22 | 897.35 | 18 |
| search_1_filter | 1 | 151.02 | 167.04 | 172.12 | 18 |
| search_3_filters | 1 | 30.81 | 44.64 | 52.45 | 18 |
| typo | 1 | 800.54 | 952.8 | 977.34 | 19 |
| nl_parsed | 1 | 122.54 | 163.29 | 172.23 | 16 |
| browse_facets | 1 | 193.26 | 236.59 | 259.16 | 13 |
| rec_similar | 1 | 1102.94 | 1264.8 | 1349.43 | 8 |
| rec_related | 1 | 1070.61 | 1288.17 | 1336.66 | 8 |
| rec_trending | 1 | 81.75 | 115.26 | 131.27 | 8 |
| search_combined_hide | 1 | 789.85 | 903.85 | 919.93 | 18 |

## Targets (F14) — PASS/FAIL

| target | measured | limit | result |
|---|---|---|---|
| predictive p95 (@100000) | 189.93ms | 60ms | **FAIL** |
| search+facets p95 (@100000) | 887.22ms | 250ms | **FAIL** |
| typo overhead p95 | 65.58ms | 30ms | **FAIL** |

## Heaviest statements — EXPLAIN (ANALYZE, BUFFERS)

```sql

    WITH seeds AS (
      SELECT product_id AS seed_id,
             title AS seed_title,
             vendor AS seed_vendor,
             product_type AS seed_type,
             tags AS seed_tags,
             price_min AS seed_price,
             ARRAY(SELECT jsonb_array_elements_text(doc->'collections')) AS seed_cols
      FROM product_search_doc
      WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
        AND published = true AND status = 'ACTIVE' AND (shopify_product_gid = ANY($3
```
```
Limit  (cost=184947.74..184947.76 rows=8 width=1139) (actual time=1546.868..1546.914 rows=8 loops=1)
  Buffers: shared hit=50454 read=28557
  CTE seeds
    ->  Result  (cost=0.42..8.96 rows=1 width=153) (actual time=0.538..0.542 rows=1 loops=1)
          One-Time Filter: (app_current_shop() = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid)
          Buffers: shared read=4
          ->  Index Scan using psd_gid_btree on product_search_doc  (cost=0.42..8.44 rows=1 width=1023) (actual time=0.236..0.238 rows=1 loops=1)
                Index Cond: ((shop_id = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid) AND (shopify_product_gid = ANY ('{gid://shopify/Product/19}'::text[])))
                Filter: (published AND (index_version_id = 'f9007779-d44d-4dbc-801d-b6a39aabf10d'::uuid) AND (status = 'ACTIVE'::text))
                Buffers: shared read=4
          SubPlan 1
            ->  ProjectSet  (cost=0.00..0.52 rows=100 width=32) (actual time=0.019..0.021 rows=2 loops=1)
```

```sql

    WITH base AS (
      SELECT product_id, shopify_product_gid AS gid, doc, title, available, product_id AS pid,
             price_min, price_max, created_at_shopify,
             ('browse'::text) AS cls,
             (0::float8) AS score
      FROM product_search_doc WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE'
    )
    SELECT b.product_id, b.gid, b.doc, b.cls, b.score,
           (SELECT count(*)::int FROM base) AS total
    FROM b
```
```
Limit  (cost=31504.01..31504.07 rows=24 width=172) (actual time=227.459..227.468 rows=24 loops=1)
  Buffers: shared hit=14454 read=9238, temp read=10792 written=10792
  CTE base
    ->  Result  (cost=0.25..25442.25 rows=86074 width=1040) (actual time=0.063..96.160 rows=85300 loops=1)
          One-Time Filter: (app_current_shop() = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid)
          Buffers: shared hit=14454 read=9238
          ->  Seq Scan on product_search_doc  (cost=0.25..25442.25 rows=86074 width=984) (actual time=0.010..88.453 rows=85300 loops=1)
                Filter: (published AND (shop_id = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid) AND (index_version_id = 'f9007779-d44d-4dbc-801d-b6a39aabf10d'::uuid) AND (status = 'ACTIVE'::text))
                Rows Removed by Filter: 14700
                Buffers: shared hit=14454 read=9238
  InitPlan 2 (returns $1)
    ->  Aggregate  (cost=1936.66..1936.68 rows=1 width=4) (actual time=178.034..178.036 rows=1 loops=1)
```

```sql

    WITH base AS (
      SELECT product_id, shopify_product_gid AS gid, doc, title, available, product_id AS pid,
             price_min, price_max, created_at_shopify,
             (CASE
      WHEN (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($5) || ' %') THEN 'sku'
      WHEN tsv @@ to_tsquery('english', immutable_unaccent($6)) THEN 'exact'
      WHEN tsv @@ to_tsquery('english', immutable_unaccent($7)) THEN 'prefix'
      WHEN false THEN 'synonym'
      WHEN false THEN '
```
```
EXPLAIN failed: bind message supplies 12 parameters, but prepared statement "" requires 10
```

```sql

    SELECT t AS value, count(*)::int AS count
    FROM product_search_doc psd, unnest(psd.tags) AS t
    WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR tsv @@ to_tsquery('english', immutable_unaccent($4)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($5) || ' %'))
    GROUP BY t
    ORDER BY count DESC, value ASC
    LIMIT 50
```
```
Limit  (cost=29054.80..29054.82 rows=10 width=36) (actual time=144.562..144.570 rows=50 loops=1)
  Buffers: shared hit=14486 read=9206
  ->  Sort  (cost=29054.80..29054.82 rows=10 width=36) (actual time=144.560..144.563 rows=50 loops=1)
        Sort Key: ((count(*))::integer) DESC, t.t
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=14486 read=9206
        ->  HashAggregate  (cost=29054.50..29054.63 rows=10 width=36) (actual time=144.511..144.524 rows=150 loops=1)
              Group Key: t.t
              Batches: 1  Memory Usage: 56kB
              Buffers: shared hit=14486 read=9206
              ->  Result  (cost=0.26..28632.06 rows=84490 width=32) (actual time=0.079..139.880 rows=32315 loops=1)
                    One-Time Filter: (app_current_shop() = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid)
```

```sql

    SELECT t AS value, count(*)::int AS count
    FROM product_search_doc psd, unnest(psd.tags) AS t
    WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($4) || ' %'))
    GROUP BY t
    ORDER BY count DESC, value ASC
    LIMIT 50
```
```
Limit  (cost=28707.80..28707.82 rows=10 width=36) (actual time=127.851..127.858 rows=50 loops=1)
  Buffers: shared hit=14518 read=9174
  ->  Sort  (cost=28707.80..28707.82 rows=10 width=36) (actual time=127.849..127.853 rows=50 loops=1)
        Sort Key: ((count(*))::integer) DESC, t.t
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=14518 read=9174
        ->  HashAggregate  (cost=28707.51..28707.63 rows=10 width=36) (actual time=127.803..127.817 rows=150 loops=1)
              Group Key: t.t
              Batches: 1  Memory Usage: 56kB
              Buffers: shared hit=14518 read=9174
              ->  Result  (cost=0.26..28304.45 rows=80610 width=32) (actual time=0.064..123.391 rows=32836 loops=1)
                    One-Time Filter: (app_current_shop() = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid)
```

```sql

    SELECT product_type AS value, count(*)::int AS count
    FROM product_search_doc
    WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($4) || ' %')) AND product_type IS NOT NULL AND product_type <> ''
    GROUP BY product_type
    ORDER BY count DESC, value ASC
    LIMIT 50
```
```
Limit  (cost=26983.20..26983.26 rows=25 width=10) (actual time=117.472..117.477 rows=25 loops=1)
  Buffers: shared hit=14550 read=9142
  ->  Sort  (cost=26983.20..26983.26 rows=25 width=10) (actual time=117.470..117.473 rows=25 loops=1)
        Sort Key: ((count(*))::integer) DESC, product_type
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=14550 read=9142
        ->  HashAggregate  (cost=26982.30..26982.62 rows=25 width=10) (actual time=117.449..117.453 rows=25 loops=1)
              Group Key: product_type
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=14550 read=9142
              ->  Result  (cost=0.25..26942.25 rows=8010 width=6) (actual time=0.054..115.894 rows=8071 loops=1)
                    One-Time Filter: (app_current_shop() = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid)
```

```sql

    SELECT vendor AS value, count(*)::int AS count
    FROM product_search_doc
    WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($4) || ' %')) AND vendor IS NOT NULL AND vendor <> ''
    GROUP BY vendor
    ORDER BY count DESC, value ASC
    LIMIT 50
```
```
Limit  (cost=26985.79..26985.89 rows=40 width=12) (actual time=141.314..141.320 rows=40 loops=1)
  Buffers: shared hit=14582 read=9110
  ->  Sort  (cost=26985.79..26985.89 rows=40 width=12) (actual time=141.312..141.314 rows=40 loops=1)
        Sort Key: ((count(*))::integer) DESC, vendor
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=14582 read=9110
        ->  HashAggregate  (cost=26984.22..26984.72 rows=40 width=12) (actual time=141.289..141.294 rows=40 loops=1)
              Group Key: vendor
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=14582 read=9110
              ->  Result  (cost=0.25..26942.25 rows=8394 width=8) (actual time=0.053..138.807 rows=8063 loops=1)
                    One-Time Filter: (app_current_shop() = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid)
```

```sql
SELECT min(price_min) AS min, max(price_max) AS max FROM product_search_doc WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($4) || ' %'))
```
```
Aggregate  (cost=26732.36..26732.37 rows=1 width=64) (actual time=101.632..101.633 rows=1 loops=1)
  Buffers: shared hit=14614 read=9078
  ->  Result  (cost=0.25..26692.25 rows=8021 width=12) (actual time=0.034..100.752 rows=8044 loops=1)
        One-Time Filter: (app_current_shop() = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid)
        Buffers: shared hit=14614 read=9078
        ->  Seq Scan on product_search_doc  (cost=0.25..26692.25 rows=8021 width=12) (actual time=0.006..100.023 rows=8044 loops=1)
              Filter: (published AND (shop_id = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid) AND (index_version_id = 'f9007779-d44d-4dbc-801d-b6a39aabf10d'::uuid) AND (status = 'ACTIVE'::text) AND ((tsv @@ '''lite'':*'::tsquery) OR (((' '::text || lower(COALESCE(sku_text, ''::text))) || ' '::text) ~~ '% lite %'::text)))
              Rows Removed by Filter: 91956
              Buffers: shared hit=14614 read=9078
Planning Time: 0.348 ms
Execution Time: 101.655 ms
```

```sql
SELECT available AS value, count(*)::int AS count FROM product_search_doc WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR tsv @@ to_tsquery('english', immutable_unaccent($4)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($5) || ' %')) GROUP BY available
```
```
HashAggregate  (cost=26984.50..26984.52 rows=2 width=5) (actual time=108.119..108.121 rows=2 loops=1)
  Group Key: available
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=14646 read=9046
  ->  Result  (cost=0.25..26942.25 rows=8449 width=1) (actual time=0.035..107.144 rows=8071 loops=1)
        One-Time Filter: (app_current_shop() = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid)
        Buffers: shared hit=14646 read=9046
        ->  Seq Scan on product_search_doc  (cost=0.25..26942.25 rows=8449 width=1) (actual time=0.011..106.500 rows=8071 loops=1)
              Filter: (published AND (shop_id = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid) AND (index_version_id = 'f9007779-d44d-4dbc-801d-b6a39aabf10d'::uuid) AND (status = 'ACTIVE'::text) AND ((tsv @@ '''stele'':*'::tsquery) OR (tsv @@ '''stele'' | ''steel'''::tsquery) OR (((' '::text || lower(COALESCE(sku_text, ''::text))) || ' '::text) ~~ '% stele %'::text)))
              Rows Removed by Filter: 91929
              Buffers: shared hit=14646 read=9046
Planning Time: 0.236 ms
```

```sql

    SELECT metafields->>$5 AS value, count(*)::int AS count
    FROM product_search_doc
    WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($4) || ' %')) AND metafields->>$5 IS NOT NULL AND metafields->>$5 <> ''
    GROUP BY value
    ORDER BY count DESC, value ASC
    LIMIT 50
```
```
Limit  (cost=27502.01..27502.03 rows=9 width=36) (actual time=103.020..103.023 rows=8 loops=1)
  Buffers: shared hit=14678 read=9014
  ->  Sort  (cost=27502.01..27502.03 rows=9 width=36) (actual time=103.018..103.019 rows=8 loops=1)
        Sort Key: ((count(*))::integer) DESC, ((metafields ->> 'custom.material'::text))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=14678 read=9014
        ->  HashAggregate  (cost=27501.73..27501.86 rows=9 width=36) (actual time=103.001..103.003 rows=8 loops=1)
              Group Key: (metafields ->> 'custom.material'::text)
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=14678 read=9014
              ->  Result  (cost=0.25..27462.08 rows=7930 width=32) (actual time=0.042..102.006 rows=5509 loops=1)
                    One-Time Filter: (app_current_shop() = 'ef35b37f-12af-4cd7-aafb-0370ea3e2ba7'::uuid)
```

## Methodology & limits

- Data loaded through `runFullSync` (parse → upsert → buildDocs → validate → activate), identical to production.
- Queries run in-process over the `app_runtime` role with RLS enabled+forced and the per-tenant `app.shop_id` GUC set — never as owner.
- Each case: 10 warm-up iterations, then N measured; percentiles are nearest-rank over wall-clock per request. Statements/request counted by instrumenting the Exec.
- EXPLAIN runs ANALYZE (so it executes) on the heaviest distinct statement shapes seen during a single-threaded profiling pass.
- Sandbox caveat: shared CPU, default PG config; treat absolute ms as indicative only.

---

## Phase 14b — also run: 10k products (indicative, same node)

Full JSON: `scripts/bench/out/bench-10000.json`. Build: 10 000 docs in ~32 s, RSS Δ ~83 MB.

| case | conc | p95 (ms) | stmts (p50) | Phase 14 baseline p95 |
|---|---|---|---|---|
| predictive | 1 | 36.7 | 14 | 183 |
| search_no_filter | 1 | 77.0 | 18 | 88 |
| browse_facets (unfiltered) | 1 | 21.7 | 13 | 85 |
| nl_parsed | 1 | 13.4 | 16 | (via scan) |
| typo | 1 | 58.5 | 19 | 162 |
| rec_similar | 1 | 133.1 | 8 | 233 |
| rec_related | 1 | 116.0 | 8 | 248 |
| search_3_filters | 1 | 16.0 | 18 | 152 |

**F14 targets @10k (14b):** predictive 36.7 ≤ 60 → **PASS**; search+facets 77 ≤ 150 → **PASS**;
typo overhead −18.6 ≤ 30 → **PASS**. (All three were FAIL/mixed at Phase 14.) 100k numbers and the
full before/after are in `docs/PHASE14B_REPORT.md`; sandbox-indicative, hosted via `benchmark.yml`.
