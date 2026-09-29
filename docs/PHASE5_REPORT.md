# Phase 5 Report — Search Relevance

Date: 2026-09-29. Built on Phase 4 (commit d507d6f), pg-verified (identical SQL
via node-postgres). No new Shopify scope, no new npm dependency, no new
PostgreSQL extension, no paid service — nothing tripped a STOP rule. Live-Prisma
confirmation is withheld until the GitHub Actions run (same discipline as Phases
3–4): the workflow already runs the full suite + real worker; you push + trigger.

> STATUS: implemented + pg-verified in the sandbox. Live-Prisma confirmation
> pending (`.github/workflows/live-prisma-check.yml`, unchanged, applies migration
> 0008 and runs the Phase 5 Prisma-integration case). Phase 6 not started.

## Design decisions

- **Damerau-Levenshtein in TypeScript; candidate generation in SQL (pg_trgm).**
  `fuzzystrmatch.levenshtein()` is classic Levenshtein (transposition = 2 edits),
  which fails "transpositions count as 1", so a new C extension would be both
  insufficient and unnecessary. `damerau.ts` is the full Lowrance-Wagner algorithm
  (adjacent transposition = 1). Candidate generation is trigram similarity over a
  GIN-indexed per-version vocabulary. **No new extension.**
- **Vocabulary derived from the docs, per index version.** Rebuilt from
  `product_search_doc.search_text` (the same fields `docInsertSql` writes — no
  fork), keyed by `index_version_id` so it follows the atomic swap/rollback, built
  ONLY from visible docs so corrections never leak draft terms.
- **One query planner drives search AND facets** (`rewrite.ts` → `match.ts`), so
  facet counts can't drift under correction/synonym/stop-word processing (Phase 4
  invariant preserved by construction).

## Extension / migration approach

Migration `0008_phase5_relevance` (additive, idempotent-from-scratch on PG16):
four tenant tables + indexes + grants + RLS. **No `CREATE EXTENSION`** (pg_trgm
from 0006 supplies the trigram GIN index; unaccent from 0006 supplies accent
folding). Policies use `DROP POLICY IF EXISTS` before `CREATE POLICY` so
re-application is safe. The CI workflow's `scripts/db-apply.sh` applies 0001→0008
by glob — no workflow change needed.

## Exact typo-distance rules

On the accent-folded token: **1-3 chars → no fuzzy; 4-7 → distance 1; 8+ →
distance 2** (`maxFuzzyDistance`). Numeric tokens (`^\d+$`) and code/SKU-like
tokens (letters+digits) are never fuzzy-matched. A token already present in the
vocabulary is treated as exact (no correction). Candidates ranked by
doc-frequency, then distance, then shared first character; ≤5 per term. Exact
always outranks fuzzy; fuzzy is per term.

## Ranking weights

`score = class_weight + ts_rank_cd(field_weights)×50 + in_stock_boost`, ordered
`score DESC, title ASC, product_id ASC` (deterministic).
Class weights: sku 600 > exact 500 > prefix 400 > synonym 300 > fuzzy 200 >
partial 100. Field weights `{A,B,C,D}={1.0,0.4,0.2,0.1}` (title > vendor/type >
tags > body). In-stock boost 10. No ML, no randomness, no personalization. The
playground shows each product's class + score.

## New tables + RLS policies

All tenant tables: `shop_id` FK, RLS **ENABLED + FORCED**, policy
`<t>_tenant_isolation USING (shop_id = app_current_shop()) WITH CHECK (shop_id =
app_current_shop())`, `SELECT/INSERT/UPDATE/DELETE` to `app_runtime` (no new
privilege; still NOSUPERUSER/NOBYPASSRLS, no CREATE on database).

- `search_vocabulary` (shop_id, index_version_id FK→index_version ON DELETE
  CASCADE, term, doc_freq, is_numeric) + GIN trigram on term.
- `search_synonym` (shop_id, kind one_way|two_way, from_term, terms[]).
- `search_stopword` (shop_id, word, mode add|remove) unique (shop, word).
- `search_redirect` (shop_id, query_normalized, destination) unique (shop, query).

## Tests — count vs 129

Sandbox: **Test Files 21 passed (21), Tests 166 passed | 5 skipped (171)** —
up from 129 (125 passed | 4 skipped). Phase 5 added **42** tests: `phase5-units`
(19: DL/transposition, length thresholds, classification, lex builders, synonym
one/two/multi-word/cap, stop-word application, redirect-destination validation
incl. external/scheme/protocol-relative/control-char rejection) and
`phase5-relevance` (22: typo correction + indicator + distance-2 + short/numeric
exclusion; synonyms one/two/multi-word; stop-word-only query + facet consistency;
redirect match + write-time rejection; RLS on all four new tables; vocabulary
consistency across build/incremental/swap/rollback; draft-term non-leakage;
facet/result consistency under fuzzy; ranking determinism exact>prefix, in-stock
boost, stable tie-break). Plus 1 skipped Phase 5 case added to
`prisma-integration` (runs on CI). `typecheck` 0 errors, `build` + `worker:build`
OK.

Prior-phase tests: all still pass. Three Phase 3 strategy-LABEL assertions were
updated to the new match classes (`and`→`exact`, near-miss→`fuzzy`); every
behavioural/invariant assertion is unchanged.

## Deviations

- Strategy labels evolved (`and`→`exact`, `trigram`→`fuzzy`); 3 Phase 3 label
  assertions updated, no invariant weakened.
- Pure any-term OR is now the `partial` fallback LEVEL (used only when the primary
  level matches nothing), not the primary match — better precision, recall kept.
- Vocabulary is a full per-version rebuild after each doc write (correctness-first;
  incremental delta = Phase 14).

## Known limitations / not tested / unsure

- **No performance numbers** (Phase 14). Per-write vocabulary rebuild is
  O(visible docs) — a known cost at large scale.
- PostgreSQL-`english` FTS strips its own stop words from both document and query,
  so a query of only english stop words can't match via FTS (documented;
  custom stop words like "sale" behave exactly as specified and are tested).
- Fuzzy is per token, not per phrase (a phrase-spanning transposition is corrected
  token-by-token).
- Accent folding: JS NFD-strip (DL) vs SQL `immutable_unaccent` (candidate gen)
  agree for Latin diacritics (English-first), not non-Latin scripts.
- Per-shop ranking weight overrides not built (kept simple, by the prompt's
  "include only if it stays simple").
- The **live Prisma path** for Phase 5 runs on CI and self-skips in the
  egress-blocked sandbox — honestly unverified here, verified on GitHub Actions.

## Next step

Push the Phase 5 changes (they apply on top of d507d6f) and run
`.github/workflows/live-prisma-check.yml` (Actions → Live Prisma Check → Run
workflow, or on push). It applies migration 0008 and runs the Phase 5
Prisma-integration case (typo correction + synonym through the real engine). Send
the run URL; I'll confirm the live results.

STATUS: PHASE 5 IMPLEMENTED & PG-VERIFIED. LIVE-PRISMA CONFIRMATION PENDING.
PHASE 6 NOT STARTED. AWAITING LIVE-PRISMA RUN AND EXPLICIT USER APPROVAL.
