# Phase 14 — Benchmark results

**Run:** 2026-11-12T12:56:56.217Z · size **30000** products · seed 1337 · N=120 · concurrency 1/8.

> **Indicative numbers — single shared sandbox node, not production.** Absolute latency on a shared container is not representative; use the hosted `benchmark.yml` workflow for comparable figures. Relative comparisons (before/after, per-query, statement counts) and the EXPLAIN plans are meaningful here.

## Machine

- Cores: 2 · RAM: 8.41 GB · linux · Node v22.22.0
- PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) · shared_buffers=128MB · work_mem=4MB · effective_cache_size=4GB

## Build (real sync→index path)

- 30000 docs in **863285.68 ms**, RSS Δ 36 MB.
- Dataset: {"active":27711,"draft":1440,"archived":849,"unpublished":2166,"unavailable":2417,"combinedParents":494,"combinedChildren":1471,"variants":88223,"collections":200}

## Query latency (ms) and statements/request

| case | conc | p50 | p95 | p99 | stmts (p50) |
|---|---|---|---|---|---|
| predictive | 1 | 68.3 | 87.8 | 93.5 | 14 |
| suggestions | 1 | 18.93 | 31.18 | 34.03 | 2 |
| search_no_filter | 1 | 292.51 | 339.59 | 367.73 | 18 |
| search_1_filter | 1 | 52.96 | 73.19 | 78.76 | 18 |
| search_3_filters | 1 | 16.19 | 23.68 | 31.6 | 18 |
| typo | 1 | 298.2 | 367.23 | 418.42 | 19 |
| nl_parsed | 1 | 49.15 | 65.85 | 72.08 | 16 |
| browse_facets | 1 | 74.47 | 92.63 | 100.99 | 13 |
| rec_similar | 1 | 375.08 | 497.58 | 509.18 | 8 |
| rec_related | 1 | 364.31 | 457.01 | 487.25 | 8 |
| rec_trending | 1 | 36.51 | 44.39 | 45.85 | 8 |
| predictive | 8 | 274.14 | 348.22 | 362.78 | 14 |
| suggestions | 8 | 76.58 | 117.03 | 127.06 | 2 |
| search_no_filter | 8 | 976.08 | 1106.69 | 1164.61 | 18 |
| search_1_filter | 8 | 224.35 | 285.47 | 309.4 | 18 |
| search_3_filters | 8 | 74.96 | 132.87 | 152.92 | 18 |
| typo | 8 | 1051.89 | 1264.03 | 1355.98 | 19 |
| nl_parsed | 8 | 188.03 | 229.49 | 238.28 | 16 |
| browse_facets | 8 | 306.53 | 379.65 | 387.82 | 13 |
| rec_similar | 8 | 1443.8 | 1767.65 | 1844.21 | 8 |
| rec_related | 8 | 1418.01 | 1718.98 | 1823.82 | 8 |
| rec_trending | 8 | 108.16 | 176.5 | 185.72 | 8 |
| search_combined_hide | 1 | 17.87 | 27.9 | 35.02 | 2 |
| write_update | 1 | 16.78 | 22.73 | 27.21 | 21 |
| write_burst | 1 | 16.9 | 24.45 | 27.77 | 21 |

## Phase 14d — stale statistics (immediately after bulk load)

product_search_doc pg_class.reltuples: **-1** stale (−1 = never analyzed) → **30000** after post-build ANALYZE. (Tables below are the 30k run; the full 10k/30k/100k stale-vs-fresh comparison is in `PHASE14D_REPORT.md`.)

### write_update per-update latency (ms)

| size | state | p50 | p95 | max |
|---|---|---|---|---|
| 30k | STALE (no ANALYZE) | 401.44 | 515.48 | 515.48 |
| 30k | FRESH (auto post-build ANALYZE) | 19.33 | 26.11 | 26.11 |
| 100k | STALE (no ANALYZE) | 1633.75 | 1798.79 | 1798.79 |
| 100k | FRESH (auto post-build ANALYZE) | 17.05 | 20.56 | 20.56 |

### key read cases p50 (ms) — stale vs fresh

| case | stale p50 | fresh p50 |
|---|---|---|
| predictive | 72.54 | 69.19 |
| search_no_filter | 304.97 | 276.85 |
| suggestions | 19.29 | 18.44 |
| rec_similar | 535.07 | 364.33 |

### delta write-path statement plans (EXPLAIN ANALYZE)

| statement | stale index on product_search_doc | stale rowsRemoved | stale buffers | fresh index | fresh buffers |
|---|---|---|---|---|---|
| vocab delta (insert/subtract) | product_search_doc_shop_idx | 29999 | 7159 | product_search_doc_version_product_key | 165 |
| facet_value delta | product_search_doc_shop_idx | 29999 | 35053 | product_search_doc_version_product_key | 97 |
| suggest delta | product_search_doc_shop_idx | 29999 | 28029 | product_search_doc_version_product_key | 63 |
| facet_summary delta | product_search_doc_shop_idx | 29999 | 7000 | product_search_doc_version_product_key | 8 |
| doc upsert | (none) | 88223 | 4355 | (none) | 22 |
| facet_summary delta | product_search_doc_shop_idx | 29999 | 7000 | product_search_doc_version_product_key | 8 |

## Targets (F14) — PASS/FAIL

| target | measured | limit | result |
|---|---|---|---|
| predictive p95 (@30000) | 87.8ms | 60ms | **FAIL** |
| search+facets p95 (@30000) | 339.59ms | 150ms | **FAIL** |
| typo overhead p95 | 27.64ms | 30ms | **PASS** |
| write_update p50 (@30000) | 16.78ms | 100ms | **PASS** |
| write_update p50 post-build-ANALYZE (@30000) | 19.33ms | 100ms | **PASS** |

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
Limit  (cost=54748.76..54748.78 rows=8 width=1141) (actual time=446.074..446.122 rows=8 loops=1)
  Buffers: shared hit=23319
  CTE seeds
    ->  Result  (cost=0.41..8.96 rows=1 width=154) (actual time=0.049..0.053 rows=1 loops=1)
          One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
          Buffers: shared hit=4
          ->  Index Scan using psd_gid_btree on product_search_doc  (cost=0.41..8.44 rows=1 width=1026) (actual time=0.019..0.021 rows=1 loops=1)
                Index Cond: ((shop_id = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid) AND (shopify_product_gid = ANY ('{gid://shopify/Product/19}'::text[])))
                Filter: (published AND (index_version_id = 'd4ad8686-9428-4019-981d-4ef6b28ce6b1'::uuid) AND (status = 'ACTIVE'::text))
                Buffers: shared hit=4
          SubPlan 1
            ->  ProjectSet  (cost=0.00..0.52 rows=100 width=32) (actual time=0.010..0.012 rows=2 loops=1)
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
Limit  (cost=8149.21..8149.27 rows=24 width=172) (actual time=38.774..38.779 rows=24 loops=1)
  Buffers: shared hit=6968
  CTE base
    ->  Result  (cost=0.25..7977.78 rows=2434 width=1042) (actual time=0.040..35.725 rows=2413 loops=1)
          One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
          Buffers: shared hit=6968
          ->  Seq Scan on product_search_doc  (cost=0.25..7868.25 rows=2434 width=1281) (actual time=0.008..32.313 rows=2413 loops=1)
                Filter: (published AND (shop_id = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid) AND (index_version_id = 'd4ad8686-9428-4019-981d-4ef6b28ce6b1'::uuid) AND (status = 'ACTIVE'::text) AND ((tsv @@ '''classic'':*'::tsquery) OR (((' '::text || lower(COALESCE(sku_text, ''::text))) || ' '::text) ~~ '% classic %'::text)))
                Rows Removed by Filter: 27587
                Buffers: shared hit=6968
  InitPlan 2 (returns $1)
    ->  Aggregate  (cost=54.77..54.78 rows=1 width=4) (actual time=37.539..37.540 rows=1 loops=1)
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
Limit  (cost=9304.10..9304.16 rows=24 width=172) (actual time=60.915..60.921 rows=24 loops=1)
  Buffers: shared hit=6968, temp read=3236 written=3236
  CTE base
    ->  Result  (cost=0.25..7493.25 rows=25713 width=1042) (actual time=0.040..25.096 rows=25550 loops=1)
          One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
          Buffers: shared hit=6968
          ->  Seq Scan on product_search_doc  (cost=0.25..7493.25 rows=25713 width=986) (actual time=0.006..23.000 rows=25550 loops=1)
                Filter: (published AND (shop_id = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid) AND (index_version_id = 'd4ad8686-9428-4019-981d-4ef6b28ce6b1'::uuid) AND (status = 'ACTIVE'::text))
                Rows Removed by Filter: 4450
                Buffers: shared hit=6968
  InitPlan 2 (returns $1)
    ->  Aggregate  (cost=578.54..578.56 rows=1 width=4) (actual time=48.317..48.318 rows=1 loops=1)
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
Limit  (cost=8477.05..8477.07 rows=10 width=36) (actual time=36.455..36.461 rows=50 loops=1)
  Buffers: shared hit=6968
  ->  Sort  (cost=8477.05..8477.07 rows=10 width=36) (actual time=36.453..36.456 rows=50 loops=1)
        Sort Key: ((count(*))::integer) DESC, t.t
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=6968
        ->  HashAggregate  (cost=8476.76..8476.88 rows=10 width=36) (actual time=36.412..36.424 rows=155 loops=1)
              Group Key: t.t
              Batches: 1  Memory Usage: 56kB
              Buffers: shared hit=6968
              ->  Result  (cost=0.26..8355.06 rows=24340 width=32) (actual time=0.058..35.229 rows=9629 loops=1)
                    One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
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
Limit  (cost=7956.32..7956.38 rows=25 width=10) (actual time=31.456..31.460 rows=25 loops=1)
  Buffers: shared hit=6968
  ->  Sort  (cost=7956.32..7956.38 rows=25 width=10) (actual time=31.455..31.457 rows=25 loops=1)
        Sort Key: ((count(*))::integer) DESC, product_type
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=6968
        ->  HashAggregate  (cost=7955.42..7955.74 rows=25 width=10) (actual time=31.440..31.443 rows=25 loops=1)
              Group Key: product_type
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=6968
              ->  Result  (cost=0.25..7943.25 rows=2434 width=6) (actual time=0.033..31.077 rows=2413 loops=1)
                    One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
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
Limit  (cost=7956.99..7957.09 rows=40 width=12) (actual time=31.174..31.179 rows=40 loops=1)
  Buffers: shared hit=6968
  ->  Sort  (cost=7956.99..7957.09 rows=40 width=12) (actual time=31.173..31.175 rows=40 loops=1)
        Sort Key: ((count(*))::integer) DESC, vendor
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=6968
        ->  HashAggregate  (cost=7955.42..7955.92 rows=40 width=12) (actual time=31.154..31.159 rows=40 loops=1)
              Group Key: vendor
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=6968
              ->  Result  (cost=0.25..7943.25 rows=2434 width=8) (actual time=0.053..30.821 rows=2413 loops=1)
                    One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
```

```sql
SELECT available AS value, count(*)::int AS count FROM product_search_doc WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($4) || ' %')) GROUP BY available
```
```
HashAggregate  (cost=7880.42..7880.45 rows=2 width=5) (actual time=30.502..30.504 rows=2 loops=1)
  Group Key: available
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=6968
  ->  Result  (cost=0.25..7868.25 rows=2434 width=1) (actual time=0.028..30.256 rows=2413 loops=1)
        One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
        Buffers: shared hit=6968
        ->  Seq Scan on product_search_doc  (cost=0.25..7868.25 rows=2434 width=1) (actual time=0.005..30.067 rows=2413 loops=1)
              Filter: (published AND (shop_id = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid) AND (index_version_id = 'd4ad8686-9428-4019-981d-4ef6b28ce6b1'::uuid) AND (status = 'ACTIVE'::text) AND ((tsv @@ '''classic'':*'::tsquery) OR (((' '::text || lower(COALESCE(sku_text, ''::text))) || ' '::text) ~~ '% classic %'::text)))
              Rows Removed by Filter: 27587
              Buffers: shared hit=6968
Planning Time: 0.183 ms
```

```sql
SELECT min(price_min) AS min, max(price_max) AS max FROM product_search_doc WHERE shop_id = $1::uuid AND index_version_id = $2::uuid
    AND published = true AND status = 'ACTIVE' AND (tsv @@ to_tsquery('english', immutable_unaccent($3)) OR tsv @@ to_tsquery('english', immutable_unaccent($4)) OR (' ' || lower(coalesce(sku_text, '')) || ' ') LIKE ('% ' || lower($5) || ' %'))
```
```
Aggregate  (cost=7955.93..7955.94 rows=1 width=64) (actual time=31.115..31.116 rows=1 loops=1)
  Buffers: shared hit=6968
  ->  Result  (cost=0.25..7943.25 rows=2535 width=12) (actual time=0.034..30.896 rows=2381 loops=1)
        One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
        Buffers: shared hit=6968
        ->  Seq Scan on product_search_doc  (cost=0.25..7943.25 rows=2535 width=12) (actual time=0.011..30.682 rows=2381 loops=1)
              Filter: (published AND (shop_id = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid) AND (index_version_id = 'd4ad8686-9428-4019-981d-4ef6b28ce6b1'::uuid) AND (status = 'ACTIVE'::text) AND ((tsv @@ '''stele'':*'::tsquery) OR (tsv @@ '''stele'' | ''steel'''::tsquery) OR (((' '::text || lower(COALESCE(sku_text, ''::text))) || ' '::text) ~~ '% stele %'::text)))
              Rows Removed by Filter: 27619
              Buffers: shared hit=6968
Planning Time: 0.351 ms
Execution Time: 31.134 ms
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
Limit  (cost=8604.30..8604.32 rows=10 width=36) (actual time=36.838..36.845 rows=50 loops=1)
  Buffers: shared hit=6968
  ->  Sort  (cost=8604.30..8604.32 rows=10 width=36) (actual time=36.836..36.839 rows=50 loops=1)
        Sort Key: ((count(*))::integer) DESC, t.t
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=6968
        ->  HashAggregate  (cost=8604.01..8604.13 rows=10 width=36) (actual time=36.794..36.807 rows=158 loops=1)
              Group Key: t.t
              Batches: 1  Memory Usage: 56kB
              Buffers: shared hit=6968
              ->  Result  (cost=0.26..8471.85 rows=26430 width=32) (actual time=0.031..35.651 rows=9800 loops=1)
                    One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
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
Limit  (cost=8112.23..8112.26 rows=11 width=36) (actual time=35.109..35.112 rows=10 loops=1)
  Buffers: shared hit=6968
  ->  Sort  (cost=8112.23..8112.26 rows=11 width=36) (actual time=35.107..35.109 rows=10 loops=1)
        Sort Key: ((count(*))::integer) DESC, ((metafields ->> 'custom.material'::text))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=6968
        ->  HashAggregate  (cost=8111.88..8112.04 rows=11 width=36) (actual time=35.096..35.098 rows=10 loops=1)
              Group Key: (metafields ->> 'custom.material'::text)
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=6968
              ->  Result  (cost=0.25..8099.46 rows=2483 width=32) (actual time=0.037..34.801 rows=1632 loops=1)
                    One-Time Filter: (app_current_shop() = 'fda0588d-9067-4c68-b31f-cd69f2657a4e'::uuid)
```

## Methodology & limits

- Data loaded through `runFullSync` (parse → upsert → buildDocs → validate → activate), identical to production.
- Queries run in-process over the `app_runtime` role with RLS enabled+forced and the per-tenant `app.shop_id` GUC set — never as owner.
- Each case: 10 warm-up iterations, then N measured; percentiles are nearest-rank over wall-clock per request. Statements/request counted by instrumenting the Exec.
- EXPLAIN runs ANALYZE (so it executes) on the heaviest distinct statement shapes seen during a single-threaded profiling pass.
- Sandbox caveat: shared CPU, default PG config; treat absolute ms as indicative only.
