# Phase 14 — Benchmark results

**Run:** 2026-11-06T11:06:29.369Z · size **100000** products · seed 1337 · N=60 · concurrency 1.

> **Indicative numbers — single shared sandbox node, not production.** Absolute latency on a shared container is not representative; use the hosted `benchmark.yml` workflow for comparable figures. Relative comparisons (before/after, per-query, statement counts) and the EXPLAIN plans are meaningful here.

## Machine

- Cores: 2 · RAM: 8.41 GB · linux · Node v22.22.0
- PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) · shared_buffers=128MB · work_mem=4MB · effective_cache_size=4GB

## Build (real sync→index path)

- 100000 docs in **357984.66 ms**, RSS Δ 45 MB.
- Dataset: {"active":92359,"draft":4734,"archived":2907,"unpublished":7059,"unavailable":8017,"combinedParents":1653,"combinedChildren":4923,"variants":295482,"collections":200}

## Query latency (ms) and statements/request

| case | conc | p50 | p95 | p99 | stmts (p50) |
|---|---|---|---|---|---|
| predictive | 1 | 1402.21 | 1500.94 | 1533.32 | 14 |
| search_no_filter | 1 | 865.51 | 930.86 | 963.98 | 18 |
| search_1_filter | 1 | 154.08 | 184.56 | 212.64 | 18 |
| search_3_filters | 1 | 34.59 | 43.53 | 47.32 | 18 |
| typo | 1 | 979.58 | 1564.2 | 1596.44 | 19 |
| nl_parsed | 1 | 530.73 | 588.95 | 609.38 | 19 |
| browse_facets | 1 | 854.5 | 908.86 | 977.49 | 13 |
| rec_similar | 1 | 2038.6 | 2273.4 | 2405.73 | 8 |
| rec_related | 1 | 1993.34 | 2227.85 | 2317.16 | 8 |
| rec_trending | 1 | 96.45 | 111.75 | 114.19 | 8 |
| search_combined_hide | 1 | 876.72 | 947.46 | 1026.08 | 18 |

## Targets (F14) — PASS/FAIL

| target | measured | limit | result |
|---|---|---|---|
| predictive p95 (@100000) | 1500.94ms | 60ms | **FAIL** |
| search+facets p95 (@100000) | 930.86ms | 250ms | **FAIL** |
| typo overhead p95 | 633.34ms | 30ms | **FAIL** |

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
Limit  (cost=205145.82..205145.84 rows=8 width=1139) (actual time=2825.827..2825.840 rows=8 loops=1)
  Buffers: shared hit=32658 read=14496
  CTE seeds
    ->  Result  (cost=0.25..25452.77 rows=1 width=153) (actual time=0.847..68.219 rows=1 loops=1)
          One-Time Filter: (app_current_shop() = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid)
          Buffers: shared hit=16327 read=7250
          ->  Seq Scan on product_search_doc  (cost=0.25..25452.25 rows=1 width=1023) (actual time=0.616..67.985 rows=1 loops=1)
                Filter: (published AND (shopify_product_gid = ANY ('{gid://shopify/Product/25}'::text[])) AND (shop_id = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid) AND (index_version_id = 'fd3b735d-61a3-40ac-89e4-a81930cdbf68'::uuid) AND (status = 'ACTIVE'::text))
                Rows Removed by Filter: 99999
                Buffers: shared hit=16327 read=7250
          SubPlan 1
            ->  ProjectSet  (cost=0.00..0.52 rows=100 width=32) (actual time=0.016..0.018 rows=3 loops=1)
```

```sql

    WITH visible AS (
      SELECT doc, title FROM product_search_doc
      WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
        AND published = true AND status = 'ACTIVE'
        AND product_id <> ALL($4::uuid[])
    ),
    terms AS (
      SELECT title AS text, 'title'::text AS type FROM visible WHERE title IS NOT NULL
      UNION ALL
      SELECT doc->>'vendor', 'vendor' FROM visible WHERE doc->>'vendor' IS NOT NULL
      UNION ALL
      SELECT doc->>'productType', 'productType' FROM
```
```
Group  (cost=112132.94..112144.08 rows=200 width=64) (actual time=1182.927..1182.933 rows=0 loops=1)
  Group Key: visible.title, ('title'::text)
  Buffers: shared hit=16337 read=7240, temp read=29178 written=9726
  CTE visible
    ->  Result  (cost=0.25..25327.25 rows=85741 width=920) (actual time=15.257..106.709 rows=85300 loops=1)
          One-Time Filter: (app_current_shop() = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid)
          Buffers: shared hit=16337 read=7240
          ->  Seq Scan on product_search_doc  (cost=0.25..25327.25 rows=85741 width=920) (actual time=0.020..83.486 rows=85300 loops=1)
                Filter: (published AND (product_id <> ALL ('{}'::uuid[])) AND (shop_id = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid) AND (index_version_id = 'fd3b735d-61a3-40ac-89e4-a81930cdbf68'::uuid) AND (status = 'ACTIVE'::text))
                Rows Removed by Filter: 14700
                Buffers: shared hit=16337 read=7240
  ->  Sort  (cost=86805.69..86809.40 rows=1485 width=64) (actual time=1182.927..1182.930 rows=0 loops=1)
```

```sql

    SELECT t AS value, count(*)::int AS count
    FROM product_search_doc psd, unnest(psd.tags) AS t
    WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE'
    GROUP BY t
    ORDER BY count DESC, value ASC
    LIMIT 50
```
```
Limit  (cost=46762.80..46762.82 rows=10 width=36) (actual time=223.866..223.873 rows=50 loops=1)
  Buffers: shared hit=16337 read=7240
  ->  Sort  (cost=46762.80..46762.82 rows=10 width=36) (actual time=223.864..223.867 rows=50 loops=1)
        Sort Key: ((count(*))::integer) DESC, t.t
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=16337 read=7240
        ->  HashAggregate  (cost=46762.50..46762.63 rows=10 width=36) (actual time=223.825..223.838 rows=150 loops=1)
              Group Key: t.t
              Batches: 1  Memory Usage: 56kB
              Buffers: shared hit=16337 read=7240
              ->  Result  (cost=0.26..42475.45 rows=857410 width=32) (actual time=0.056..187.394 rows=341184 loops=1)
                    One-Time Filter: (app_current_shop() = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid)
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
Limit  (cost=31365.56..31365.62 rows=24 width=172) (actual time=192.895..192.901 rows=24 loops=1)
  Buffers: shared hit=16348 read=7229, temp read=10793 written=10793
  CTE base
    ->  Result  (cost=0.25..25327.25 rows=85741 width=1040) (actual time=0.045..76.756 rows=85300 loops=1)
          One-Time Filter: (app_current_shop() = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid)
          Buffers: shared hit=16348 read=7229
          ->  Seq Scan on product_search_doc  (cost=0.25..25327.25 rows=85741 width=984) (actual time=0.007..69.825 rows=85300 loops=1)
                Filter: (published AND (shop_id = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid) AND (index_version_id = 'fd3b735d-61a3-40ac-89e4-a81930cdbf68'::uuid) AND (status = 'ACTIVE'::text))
                Rows Removed by Filter: 14700
                Buffers: shared hit=16348 read=7229
  InitPlan 2 (returns $1)
    ->  Aggregate  (cost=1929.17..1929.18 rows=1 width=4) (actual time=150.097..150.098 rows=1 loops=1)
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
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($4) || ' %'))
    GROUP BY t
    ORDER BY count DESC, value ASC
    LIMIT 50
```
```
Limit  (cost=28700.05..28700.07 rows=10 width=36) (actual time=147.556..147.564 rows=50 loops=1)
  Buffers: shared hit=16350 read=7227
  ->  Sort  (cost=28700.05..28700.07 rows=10 width=36) (actual time=147.555..147.558 rows=50 loops=1)
        Sort Key: ((count(*))::integer) DESC, t.t
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=16350 read=7227
        ->  HashAggregate  (cost=28699.76..28699.88 rows=10 width=36) (actual time=147.491..147.520 rows=150 loops=1)
              Group Key: t.t
              Batches: 1  Memory Usage: 56kB
              Buffers: shared hit=16350 read=7227
              ->  Result  (cost=0.26..28275.26 rows=84900 width=32) (actual time=0.042..142.147 rows=32732 loops=1)
                    One-Time Filter: (app_current_shop() = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid)
```

```sql

    SELECT product_type AS value, count(*)::int AS count
    FROM product_search_doc
    WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR tsv @@ to_tsquery('english', immutable_unaccent($4)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($5) || ' %')) AND product_type IS NOT NULL AND product_type <> ''
    GROUP BY product_type
    ORDER BY count DESC, value 
```
```
Limit  (cost=27121.72..27121.78 rows=25 width=10) (actual time=133.088..133.093 rows=25 loops=1)
  Buffers: shared hit=16351 read=7226
  ->  Sort  (cost=27121.72..27121.78 rows=25 width=10) (actual time=133.087..133.089 rows=25 loops=1)
        Sort Key: ((count(*))::integer) DESC, product_type
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=16351 read=7226
        ->  HashAggregate  (cost=27120.83..27121.14 rows=25 width=10) (actual time=133.070..133.073 rows=25 loops=1)
              Group Key: product_type
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=16351 read=7226
              ->  Result  (cost=0.25..27077.25 rows=8715 width=6) (actual time=0.048..131.272 rows=8009 loops=1)
                    One-Time Filter: (app_current_shop() = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid)
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
Limit  (cost=29006.30..29006.32 rows=10 width=36) (actual time=128.768..128.774 rows=50 loops=1)
  Buffers: shared hit=16351 read=7226
  ->  Sort  (cost=29006.30..29006.32 rows=10 width=36) (actual time=128.766..128.769 rows=50 loops=1)
        Sort Key: ((count(*))::integer) DESC, t.t
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=16351 read=7226
        ->  HashAggregate  (cost=29006.01..29006.13 rows=10 width=36) (actual time=128.725..128.738 rows=150 loops=1)
              Group Key: t.t
              Batches: 1  Memory Usage: 56kB
              Buffers: shared hit=16351 read=7226
              ->  Result  (cost=0.26..28570.26 rows=87150 width=32) (actual time=0.046..124.427 rows=32528 loops=1)
                    One-Time Filter: (app_current_shop() = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid)
```

```sql

    SELECT metafields->>$6 AS value, count(*)::int AS count
    FROM product_search_doc
    WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR tsv @@ to_tsquery('english', immutable_unaccent($4)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($5) || ' %')) AND metafields->>$6 IS NOT NULL AND metafields->>$6 <> ''
    GROUP BY value
    ORDER BY count DESC, valu
```
```
Limit  (cost=27642.24..27642.26 rows=9 width=36) (actual time=107.073..107.076 rows=8 loops=1)
  Buffers: shared hit=16352 read=7225
  ->  Sort  (cost=27642.24..27642.26 rows=9 width=36) (actual time=107.067..107.068 rows=8 loops=1)
        Sort Key: ((count(*))::integer) DESC, ((metafields ->> 'custom.material'::text))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=16352 read=7225
        ->  HashAggregate  (cost=27641.96..27642.10 rows=9 width=36) (actual time=107.053..107.055 rows=8 loops=1)
              Group Key: (metafields ->> 'custom.material'::text)
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=16352 read=7225
              ->  Result  (cost=0.25..27598.82 rows=8628 width=32) (actual time=0.034..106.165 rows=5445 loops=1)
                    One-Time Filter: (app_current_shop() = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid)
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
Limit  (cost=26869.40..26869.46 rows=25 width=10) (actual time=122.798..122.802 rows=25 loops=1)
  Buffers: shared hit=16352 read=7225
  ->  Sort  (cost=26869.40..26869.46 rows=25 width=10) (actual time=122.796..122.798 rows=25 loops=1)
        Sort Key: ((count(*))::integer) DESC, product_type
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=16352 read=7225
        ->  HashAggregate  (cost=26868.50..26868.81 rows=25 width=10) (actual time=122.778..122.781 rows=25 loops=1)
              Group Key: product_type
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=16352 read=7225
              ->  Result  (cost=0.25..26827.25 rows=8250 width=6) (actual time=0.040..121.164 rows=8122 loops=1)
                    One-Time Filter: (app_current_shop() = 'e4b919ff-4637-4051-84e2-14a07e1bfb96'::uuid)
```

## Methodology & limits

- Data loaded through `runFullSync` (parse → upsert → buildDocs → validate → activate), identical to production.
- Queries run in-process over the `app_runtime` role with RLS enabled+forced and the per-tenant `app.shop_id` GUC set — never as owner.
- Each case: 10 warm-up iterations, then N measured; percentiles are nearest-rank over wall-clock per request. Statements/request counted by instrumenting the Exec.
- EXPLAIN runs ANALYZE (so it executes) on the heaviest distinct statement shapes seen during a single-threaded profiling pass.
- Sandbox caveat: shared CPU, default PG config; treat absolute ms as indicative only.

---

## Also run: 10k products (indicative, same node)

Full JSON: `scripts/bench/out/bench-10000.json` (the 100k run above is
`bench-100000.json`). Build: 10 000 docs in **~55 s**, RSS Δ **85 MB**.

| case | conc | p95 (ms) | stmts (p50) |
|---|---|---|---|
| predictive | 1 | 183 | 14 |
| search_no_filter | 1 | 88 | 18 |
| search_1_filter | 1 | 25 | 18 |
| search_3_filters | 1 | 152 | 14 |
| typo | 1 | 162 | 19 |
| browse_facets | 1 | 85 | 13 |
| rec_similar | 1 | 233 | 8 |
| rec_related | 1 | 248 | 8 |
| rec_trending | 1 | 11 | 8 |

**F14 targets @10k:** predictive 183 ms vs ≤60 → **FAIL**; search+facets 88 ms vs
≤150 → **PASS**; typo overhead +74 ms vs ≤+30 → **FAIL**. (RSS Δ is lower at 100k
than 10k — build memory is bounded, not linear in catalog size.)
