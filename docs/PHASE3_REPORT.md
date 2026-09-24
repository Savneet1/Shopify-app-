# Phase 3 Report — Search & Discovery

Date: 2026-09-22. Approach: **option 3** — Phase 3.1–3.8 built now using the
pg-verified approach (identical SQL via node-postgres, same as Phases 1–2.1),
with G1–G10 fully implemented in code and tests. G1/G3 and the Prisma-backed
execution of Phase 3 are marked pg-verified, **not yet confirmed on a live Prisma
engine** (this sandbox's egress denies `binaries.prisma.sh`; that must not be
routed around).

> STATUS: implementation and pg-verification complete. **Not declaring "PHASE 3
> COMPLETE" yet** — awaiting your live-Prisma logs (`prisma generate`,
> `npm test`, `npm run worker`) from an engine-enabled machine before the report
> is finalized and Phase 4 is approved.

## Requirement Preservation Check

No approved requirement or architecture was changed. Global rules held: no Redis,
no external search engine, no AI/LLM/embeddings/pgvector, no paid SaaS, no other
Shopify app dependency, **no new Shopify scope** (result-card + publication
fields are `read_products`), no restored Phase 1 exhaustive isolation matrix
(only the functional + specifically-listed isolation/security tests were added).
No performance target is claimed. Search queries are not logged.

## What was built (3.1–3.8)

- **3.1/3.2** — migration `0006_phase3_search` (additive): `pg_trgm` + `unaccent`
  extensions, IMMUTABLE `immutable_unaccent` wrapper, result-card columns
  (product image url/alt, `online_store_url`, variant `compare_at_price`), and
  `product_search_doc` search columns (`tsv`, `title`, `sku_text`, `status`,
  `published`, `available`) + GIN/trigram/filter indexes. Weighted tsvector
  (A title; B vendor/type/SKU+barcode; C tags/collection/variant titles;
  D description) and the enriched card `doc` are computed inside the single
  shared `docInsertSql`, so build / in-place refresh / activation catch-up stay
  identical. Result-card capture wired through `bulk.server.ts` → `normalize.ts`
  → `store.ts` for both bulk and incremental paths. Backfill helper added.
- **3.3** — query engine (`app/lib/search/query.ts`): ACTIVE-version-only,
  published+ACTIVE visibility, parameterised/sanitised tsqueries, length/limit/
  offset bounds, `SET LOCAL statement_timeout`, strategy cascade
  (AND→prefix→OR→trigram) with exact SKU/barcode first, `ts_rank_cd` baseline,
  `{products,total,strategy,indexVersion,tookMs,fallback?}`.
- **3.4** — predictive search + catalog-derived suggestions (no popularity).
- **3.5** — degraded-mode fallback: `fallback:"native"` (no active index /
  timeout / DB error, HTTP 200 — never a bare 500) and a structured zero-result
  block with catalog suggestions.
- **3.6** — App Proxy JSON API (`/apps/search/{products,predictive,suggest}`,
  `[app_proxy]` config); signature-verified, shop taken from the verified
  signature (tampered `?shop` rejected); JSON only; Redis-free per-shop token
  bucket rate limiter (documented multi-instance limitation).
- **3.7** — admin Search playground (`/app/search`, session-authenticated, nav
  link).
- **3.8** — 30 new tests (see below).

Full detail: `docs/PHASE3.md`. Feature Matrix updated (`docs/FEATURE_MATRIX.md`).

## G1–G10 status

| Gate | Status |
|---|---|
| **G1** Prisma-integration test RUNS + extended | **Code done; pg-verified; RUNS on an engine machine, SKIPS here.** Extended with a Phase 3 search case (`searchProducts` by title + by SKU through real Prisma `withShopExec`). Self-skips when the engine is unavailable. |
| **G2** Fix uncast Phase 1 SQL + audit | Done (Phase 2.1). New Phase 3 SQL uses explicit `::uuid/::int/::text` casts throughout. |
| **G3** Real `npm run worker` + deployable | **Deployable bundle built + pg-verified; live run needs the engine.** Unchanged by Phase 3 (worker does not import the search/route layer). |
| **G4** Reconciliation race (snapshot start) | Done + tested (Phase 3.0). |
| **G5** Catch-up boundary safety margin | Done + documented (Phase 3.0). |
| **G6** Incremental refetch must not truncate | Done + tested (Phase 3.0). |
| **G7** Collection webhooks refresh member docs | Done + tested; member-doc refresh now also recomputes the weighted tsvector (shared `docInsertSql`). |
| **G8** Scheduled reconciliation via pg-boss | Done + tested + verified (Phase 3.0). |
| **G9** Full-sync enqueue policy (stately) | Done + tested (Phase 3.0). |
| **G10** Correct FEATURE_MATRIX | Done; matrix updated for Phase 3. |

## Tests

New (30): `phase3-search` (21), `phase3-appproxy` (8), `phase3-index-usage` (1,
informational). All pg-verified (node-postgres, identical SQL to production).
`prisma-integration` extended with a Phase 3 search case (skips here).

Security/isolation added (per the reduced, targeted list — NOT the Phase 1
matrix): excluded-content exclusion (draft/archived/unpublished never returned,
not even by exact SKU); App Proxy invalid-signature rejection; shop-derived-from-
signature (tampered `?shop` rejected); ONE cross-shop test (A never sees B; A
cannot read B's docs given B's version id — RLS); query hardening (tsquery
metacharacters / SQL-ish input cannot break the query or inject).

### Command outputs (this sandbox)

```
npm test          → Test Files 18 passed (18)   Tests 107 passed | 3 skipped (110)
npm run typecheck → 0 errors
npm run build     → exit 0
npm run worker:build → worker bundled -> build/worker/run-worker.js
```

Per-file (Phase 3): `phase3-search` 21, `phase3-appproxy` 8,
`phase3-index-usage` 1. The 3 skipped are `prisma-integration` (engine-gated).

The EXPLAIN check is informational: at 10k rows for a single shop the planner may
prefer a shop-index/seq scan over the tsv GIN (a cost-model choice, not a
correctness issue). The test asserts the `psd_tsv_gin` index exists, is valid and
is GIN, and that the FTS query returns the exact expected rows. **No latency
target is asserted (Phase 14).**

## Dependencies / scopes

- **npm dependencies added: none.**
- **Shopify scopes added: none** (result-card + publication fields are
  `read_products`; `onlineStoreUrl` is the publication signal — no
  `read_publications`).
- **PostgreSQL extensions enabled:** `pg_trgm`, `unaccent` — both TRUSTED contrib
  (installable by the non-superuser owner), no external account, no data egress.

## What still requires an engine-enabled machine

1. **G1** — the actual Prisma-integration RUN, now including the Phase 3 search
   case (written; self-skips here).
2. **G3** — the Prisma-backed `npm run worker` connecting + processing a real job
   (bundle + pg-boss lifecycle already proven via `worker:smoke`).
3. **Phase 3 execution through Prisma** — `searchProducts`, `predictiveSearch`,
   `suggest`, `storefrontSearch` and the App Proxy routes all use the production
   `withShopExec` (Prisma). The SQL is byte-for-byte the pg-verified SQL, but its
   execution through the Prisma engine is confirmed only on an engine machine.

## Next step (awaiting you)

Please run on a machine with Prisma engine access and paste the logs:

```
prisma generate
npm test
npm run worker
```

Once those confirm G1/G3 and the Phase 3 Prisma path, I will finalize this report
with the live-Prisma results and the closing status line. **I am not starting
Phase 4** until you review the logs and give explicit approval.

STATUS: PHASE 3 IMPLEMENTED & PG-VERIFIED. LIVE-PRISMA CONFIRMATION PENDING.
PHASE 4 NOT STARTED. AWAITING LIVE-PRISMA LOGS AND EXPLICIT USER APPROVAL.
