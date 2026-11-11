# Phase 14 — Benchmark results

**Run:** 2026-11-11T11:20:06.220Z · size **10000** products · seed 1337 · N=60 · concurrency 1/8.

> **Indicative numbers — single shared sandbox node, not production.** Absolute latency on a shared container is not representative; use the hosted `benchmark.yml` workflow for comparable figures. Relative comparisons (before/after, per-query, statement counts) and the EXPLAIN plans are meaningful here.

## Machine

- Cores: 2 · RAM: 8.41 GB · linux · Node v22.22.0
- PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) · shared_buffers=128MB · work_mem=4MB · effective_cache_size=4GB

## Build (real sync→index path)

- 10000 docs in **64736.2 ms**, RSS Δ 83 MB.
- Dataset: {"active":9203,"draft":496,"archived":301,"unpublished":711,"unavailable":807,"combinedParents":156,"combinedChildren":461,"variants":29466,"collections":200}

## Query latency (ms) and statements/request

| case | conc | p50 | p95 | p99 | stmts (p50) |
|---|---|---|---|---|---|
| predictive | 1 | 31.96 | 48.84 | 54.89 | 14 |
| search_no_filter | 1 | 78.51 | 119.9 | 128.06 | 18 |
| search_1_filter | 1 | 28.2 | 33.54 | 39.8 | 18 |
| search_3_filters | 1 | 17.24 | 28.82 | 30.83 | 14 |
| typo | 1 | 76.01 | 117.87 | 144.5 | 19 |
| nl_parsed | 1 | 19.7 | 24.04 | 28.63 | 16 |
| browse_facets | 1 | 28.07 | 35.28 | 36.49 | 13 |
| rec_similar | 1 | 139.66 | 185.3 | 207.73 | 8 |
| rec_related | 1 | 161.67 | 225.04 | 242.07 | 8 |
| rec_trending | 1 | 11.64 | 14 | 25.2 | 8 |
| predictive | 8 | 129.56 | 213.87 | 213.94 | 14 |
| search_no_filter | 8 | 282.65 | 462.94 | 463.68 | 18 |
| search_1_filter | 8 | 75.83 | 151.81 | 152.19 | 18 |
| search_3_filters | 8 | 63.95 | 117.75 | 131.44 | 14 |
| typo | 8 | 255.43 | 353.84 | 399.22 | 18 |
| nl_parsed | 8 | 89.76 | 121.46 | 131.86 | 16 |
| browse_facets | 8 | 111.75 | 167.74 | 177.87 | 13 |
| rec_similar | 8 | 536.78 | 707.76 | 739.78 | 8 |
| rec_related | 8 | 529.96 | 696.67 | 739.59 | 8 |
| rec_trending | 8 | 30.73 | 52.29 | 62.61 | 8 |
| search_combined_hide | 1 | 68.89 | 94.81 | 104.97 | 18 |
| write_update | 1 | 15.58 | 21.47 | 24.44 | 21 |
| write_burst | 1 | 16.02 | 21.71 | 24.99 | 21 |

## Targets (F14) — PASS/FAIL

| target | measured | limit | result |
|---|---|---|---|
| predictive p95 (@10000) | 48.84ms | 60ms | **PASS** |
| search+facets p95 (@10000) | 119.9ms | 150ms | **PASS** |
| typo overhead p95 | -2.02ms | 30ms | **PASS** |
| write_update p50 (@10000) | 15.58ms | 100ms | **PASS** |

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
Limit  (cost=19986.76..19986.78 rows=8 width=1144) (actual time=209.158..209.196 rows=8 loops=1)
  Buffers: shared hit=11139
  CTE seeds
    ->  Result  (cost=0.41..8.96 rows=1 width=153) (actual time=0.084..0.088 rows=1 loops=1)
          One-Time Filter: (app_current_shop() = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid)
          Buffers: shared hit=4
          ->  Index Scan using psd_gid_btree on product_search_doc  (cost=0.41..8.44 rows=1 width=1029) (actual time=0.024..0.026 rows=1 loops=1)
                Index Cond: ((shop_id = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid) AND (shopify_product_gid = ANY ('{gid://shopify/Product/7}'::text[])))
                Filter: (published AND (index_version_id = '84b3f5fd-ed18-43a4-8460-3c7d1f471bdf'::uuid) AND (status = 'ACTIVE'::text))
                Buffers: shared hit=4
          SubPlan 1
            ->  ProjectSet  (cost=0.00..0.52 rows=100 width=32) (actual time=0.009..0.012 rows=1 loops=1)
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
Limit  (cost=3446.33..3446.39 rows=24 width=172) (actual time=24.318..24.323 rows=24 loops=1)
  Buffers: shared hit=2669, temp read=1079 written=1080
  CTE base
    ->  Result  (cost=0.25..2844.25 rows=8549 width=1045) (actual time=0.057..8.152 rows=8492 loops=1)
          One-Time Filter: (app_current_shop() = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid)
          Buffers: shared hit=2669
          ->  Seq Scan on product_search_doc  (cost=0.25..2844.25 rows=8549 width=989) (actual time=0.008..7.111 rows=8492 loops=1)
                Filter: (published AND (shop_id = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid) AND (index_version_id = '84b3f5fd-ed18-43a4-8460-3c7d1f471bdf'::uuid) AND (status = 'ACTIVE'::text))
                Rows Removed by Filter: 1508
                Buffers: shared hit=2669
  InitPlan 2 (returns $1)
    ->  Aggregate  (cost=192.35..192.36 rows=1 width=4) (actual time=18.720..18.720 rows=1 loops=1)
```

```sql
SELECT text, type FROM search_suggest_term
         WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
           AND text <> '' AND immutable_unaccent(lower(text)) LIKE immutable_unaccent(lower($3)) ESCAPE '\'
```
```
Result  (cost=0.29..4.56 rows=1 width=24) (actual time=8.558..11.125 rows=309 loops=1)
  One-Time Filter: (app_current_shop() = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid)
  Buffers: shared hit=84
  ->  Index Scan using search_suggest_term_version_idx on search_suggest_term  (cost=0.29..4.56 rows=1 width=24) (actual time=8.531..11.067 rows=309 loops=1)
        Index Cond: (index_version_id = '84b3f5fd-ed18-43a4-8460-3c7d1f471bdf'::uuid)
        Filter: ((text <> ''::text) AND (shop_id = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid) AND (immutable_unaccent(lower(text)) ~~ 'travel%'::text))
        Rows Removed by Filter: 5824
        Buffers: shared hit=84
Planning:
  Buffers: shared hit=1
Planning Time: 0.144 ms
Execution Time: 11.154 ms
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
Limit  (cost=3164.80..3164.82 rows=10 width=36) (actual time=17.191..17.199 rows=50 loops=1)
  Buffers: shared hit=2669
  ->  Sort  (cost=3164.80..3164.82 rows=10 width=36) (actual time=17.190..17.193 rows=50 loops=1)
        Sort Key: ((count(*))::integer) DESC, t.t
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=2669
        ->  HashAggregate  (cost=3164.51..3164.63 rows=10 width=36) (actual time=17.130..17.146 rows=150 loops=1)
              Group Key: t.t
              Batches: 1  Memory Usage: 56kB
              Buffers: shared hit=2669
              ->  Result  (cost=0.26..3125.45 rows=7810 width=32) (actual time=0.050..16.335 rows=3081 loops=1)
                    One-Time Filter: (app_current_shop() = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid)
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
Limit  (cost=3216.30..3216.32 rows=10 width=36) (actual time=14.640..14.647 rows=50 loops=1)
  Buffers: shared hit=2669
  ->  Sort  (cost=3216.30..3216.32 rows=10 width=36) (actual time=14.639..14.642 rows=50 loops=1)
        Sort Key: ((count(*))::integer) DESC, t.t
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=2669
        ->  HashAggregate  (cost=3216.01..3216.13 rows=10 width=36) (actual time=14.582..14.597 rows=150 loops=1)
              Group Key: t.t
              Batches: 1  Memory Usage: 56kB
              Buffers: shared hit=2669
              ->  Result  (cost=0.26..3171.65 rows=8870 width=32) (actual time=0.085..14.034 rows=3189 loops=1)
                    One-Time Filter: (app_current_shop() = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid)
```

```sql

    SELECT vendor AS value, count(*)::int AS count
    FROM product_search_doc
    WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR tsv @@ to_tsquery('english', immutable_unaccent($4)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($5) || ' %')) AND vendor IS NOT NULL AND vendor <> ''
    GROUP BY vendor
    ORDER BY count DESC, value ASC
    LIMIT 50
```
```
Limit  (cost=3025.25..3025.35 rows=40 width=12) (actual time=12.270..12.276 rows=40 loops=1)
  Buffers: shared hit=2669
  ->  Sort  (cost=3025.25..3025.35 rows=40 width=12) (actual time=12.269..12.272 rows=40 loops=1)
        Sort Key: ((count(*))::integer) DESC, vendor
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=2669
        ->  HashAggregate  (cost=3023.69..3024.19 rows=40 width=12) (actual time=12.247..12.251 rows=40 loops=1)
              Group Key: vendor
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=2669
              ->  Result  (cost=0.25..3019.25 rows=887 width=8) (actual time=0.058..12.080 rows=810 loops=1)
                    One-Time Filter: (app_current_shop() = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid)
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
Limit  (cost=3024.58..3024.64 rows=25 width=10) (actual time=19.009..19.014 rows=25 loops=1)
  Buffers: shared hit=2669
  ->  Sort  (cost=3024.58..3024.64 rows=25 width=10) (actual time=19.008..19.010 rows=25 loops=1)
        Sort Key: ((count(*))::integer) DESC, product_type
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=2669
        ->  HashAggregate  (cost=3023.69..3024.00 rows=25 width=10) (actual time=18.993..18.996 rows=25 loops=1)
              Group Key: product_type
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=2669
              ->  Result  (cost=0.25..3019.25 rows=887 width=6) (actual time=0.047..18.780 rows=810 loops=1)
                    One-Time Filter: (app_current_shop() = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid)
```

```sql
SELECT min(price_min) AS min, max(price_max) AS max FROM product_search_doc WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($4) || ' %'))
```
```
Aggregate  (cost=2973.43..2973.44 rows=1 width=64) (actual time=22.028..22.029 rows=1 loops=1)
  Buffers: shared hit=2669
  ->  Result  (cost=0.25..2969.25 rows=835 width=12) (actual time=0.064..21.903 rows=835 loops=1)
        One-Time Filter: (app_current_shop() = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid)
        Buffers: shared hit=2669
        ->  Seq Scan on product_search_doc  (cost=0.25..2969.25 rows=835 width=12) (actual time=0.036..21.791 rows=835 loops=1)
              Filter: (published AND (shop_id = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid) AND (index_version_id = '84b3f5fd-ed18-43a4-8460-3c7d1f471bdf'::uuid) AND (status = 'ACTIVE'::text) AND ((tsv @@ '''red'':*'::tsquery) OR (((' '::text || lower(COALESCE(sku_text, ''::text))) || ' '::text) ~~ '% red %'::text)))
              Rows Removed by Filter: 9165
              Buffers: shared hit=2669
Planning Time: 0.389 ms
Execution Time: 22.048 ms
```

```sql
SELECT available AS value, count(*)::int AS count FROM product_search_doc WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($4) || ' %')) GROUP BY available
```
```
HashAggregate  (cost=2973.16..2973.18 rows=2 width=5) (actual time=16.805..16.806 rows=2 loops=1)
  Group Key: available
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=2669
  ->  Result  (cost=0.25..2969.25 rows=781 width=1) (actual time=0.041..16.683 rows=772 loops=1)
        One-Time Filter: (app_current_shop() = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid)
        Buffers: shared hit=2669
        ->  Seq Scan on product_search_doc  (cost=0.25..2969.25 rows=781 width=1) (actual time=0.010..16.575 rows=772 loops=1)
              Filter: (published AND (shop_id = '74974864-7767-4bdd-b44b-aafeb1d6db86'::uuid) AND (index_version_id = '84b3f5fd-ed18-43a4-8460-3c7d1f471bdf'::uuid) AND (status = 'ACTIVE'::text) AND ((tsv @@ '''premium'':*'::tsquery) OR (((' '::text || lower(COALESCE(sku_text, ''::text))) || ' '::text) ~~ '% premium %'::text)))
              Rows Removed by Filter: 9228
              Buffers: shared hit=2669
Planning Time: 0.253 ms
```

## Methodology & limits

- Data loaded through `runFullSync` (parse → upsert → buildDocs → validate → activate), identical to production.
- Queries run in-process over the `app_runtime` role with RLS enabled+forced and the per-tenant `app.shop_id` GUC set — never as owner.
- Each case: 10 warm-up iterations, then N measured; percentiles are nearest-rank over wall-clock per request. Statements/request counted by instrumenting the Exec.
- EXPLAIN runs ANALYZE (so it executes) on the heaviest distinct statement shapes seen during a single-threaded profiling pass.
- Sandbox caveat: shared CPU, default PG config; treat absolute ms as indicative only.

---

## Phase 14c — write-path (delta maintenance), indicative sandbox

New harness cases `write_update` (single product update) and `write_burst` (bulk
updates), both through the real `applyProductUpsert` apply path.

| metric | 10k before→after | 100k before→after |
|---|---|---|
| per-update p50 | 1231 → **15.6 ms** | 10 428 → **30.9 ms** |
| per-update p95 | 1531 → 21.5 ms | 10 832 → 43.6 ms |
| statements/update | — → 21 | — → 21 |
| burst drain | 2000 upd: **33.5 s** | 1500 upd: **30.9 s** |

"before" = the 17ec787 full-rebuild cost each update paid (measured in-run via
`baselineRebuild`). **write_update p50 ≤ 100 ms target → PASS; growth 10k→100k =
1.98× ≤ ~2× → PASS.** Sandbox-indicative; hosted via `benchmark.yml`.
