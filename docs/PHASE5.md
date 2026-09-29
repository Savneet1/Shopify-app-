# Phase 5 — Search Relevance

Typo tolerance, synonyms, stop words, redirects and rule-based ranking, layered
on the Phase 3/4 search engine. API + admin only (no theme/storefront UI —
Phase 7). Global rules held: **no Redis, no external search/AI/ML, no paid SaaS,
no new Shopify scope, no new npm dependency, and no new PostgreSQL extension**
(pg_trgm from Phase 3 is reused; Damerau-Levenshtein is in TypeScript).

## Design decisions

- **Damerau-Levenshtein in TypeScript, candidate generation in SQL.** The
  precise edit-distance scoring (with the length thresholds and tie-break rules)
  is one tested function (`app/lib/search/damerau.ts`, full Lowrance-Wagner —
  adjacent transposition costs 1). Candidate GENERATION is `pg_trgm` similarity
  (`term % q`) over a GIN-indexed vocabulary. Rationale: `fuzzystrmatch`'s
  `levenshtein()` is classic Levenshtein (a transposition costs 2, not 1), so it
  would not satisfy "transpositions count as 1 edit"; adding a C extension for a
  distance we can compute exactly in TS is unnecessary. So **no new extension.**
- **Vocabulary is derived, per index version, from the docs.** Rather than fork
  `docInsertSql`, the vocabulary is rebuilt from `product_search_doc.search_text`
  (the same concatenated fields `docInsertSql` already writes). It is keyed by
  `index_version_id`, so it follows the versioned lifecycle and the atomic swap
  automatically, and is built ONLY from VISIBLE docs (published + status ACTIVE),
  so corrections can never surface a draft/unpublished term.
- **The query planner drives search AND facets.** A single `QueryPlan`
  (`rewrite.ts`) — stop-word-filtered tokens, per-term fuzzy candidates, synonym
  expansions — is turned into one effective match predicate (`match.ts`) shared
  by the product query and every facet count, so facet counts never drift under
  correction / synonym / stop-word processing (the Phase 4 invariant is
  preserved by construction).

## 5.1 Typo tolerance

- **Vocabulary** (`search_vocabulary`): `(shop_id, index_version_id, term,
  doc_freq, is_numeric)`. Rebuilt (`rebuildVocabulary`) after EVERY doc-writing
  path — full build, incremental refresh, activation catch-up, collection-member
  refresh, and the backfill/reindex path — so it always matches its version's
  visible docs. Only the ACTIVE version's vocabulary is read at query time.
- **Distance rules** (on the accent-folded token): **1-3 chars → no fuzzy;
  4-7 → distance 1; 8+ → distance 2.** Numeric tokens and code/SKU-like tokens
  (letters+digits) are never fuzzy-matched. A token that is already an exact
  vocabulary term is not corrected.
- **Candidate ranking**: higher document frequency, then smaller distance, then
  shared first character, capped at 5 per term. Exact matches always outrank
  fuzzy (ranking below); fuzzy is applied per term, not to the whole query.
- **Correction indicator**: the response carries `corrected`, `corrections`
  (`[{from,to}]`) and `correctedQuery`, with the original `query` preserved — so
  the UI can show "showing results for X / did you mean".

## 5.2 Synonyms (`search_synonym`)

Per-shop, admin-managed, applied at QUERY time (no reindex on change). `two_way`
(equivalence group a⇔b⇔c) and `one_way` (from → targets); multi-word phrases are
matched as contiguous token n-grams. Caps: ≤1000 synonyms/shop, ≤20 expansions/
query (truncation flagged), ≤10 terms/rule — all with clear errors. Synonym
matches are class `synonym`, which ranks below exact/prefix of the original term.

## 5.3 Stop words (`search_stopword`)

A default English list plus per-shop `add`/`remove` overrides; effective set =
(defaults − removed) ∪ added. Stop words are dropped from matching only when at
least one non-stop term remains; an all-stop-words query keeps them all. The
planner runs once, so the same effective set applies to search, predictive and
facet counting.

> Interaction to know: PostgreSQL's `english` text-search config ALSO removes its
> own stop words from both the document `tsvector` and the query `tsquery`. Our
> per-shop stop-word layer is additive and independent. A query composed entirely
> of PostgreSQL-english stop words (e.g. "the of") cannot match via FTS (those
> lexemes aren't in any `tsvector`); it still runs and can match an exact SKU.
> Custom (non-english) stop words like "sale" behave exactly as specified and are
> tested.

## 5.4 Redirects (`search_redirect`)

Per-shop `query_normalized → destination`, matched on the normalized query
(case/whitespace/punctuation) with EXACT match only. The API returns the redirect
in the payload; **the server never issues a 30x.** Destination validation
(`validateDestination`, at write AND read time — fail closed): a same-shop
relative path (single leading `/`, not `//` or `/\`), or an absolute **https** URL
on the shop's OWN host. External hosts, protocol-relative `//host`, and
`javascript:`/`data:`/`vbscript:`/`file:` schemes (incl. control-character
bypasses) are rejected.

## 5.5 Rule-based ranking (`ranking.ts`)

Deterministic, no ML/learned weights/personalization/randomness. Per product:

```
score = class_weight + field_score*FIELD_SCALE + in_stock_boost
```

- **Match class** (well-separated weights so class dominates):
  sku 600 > exact 500 > prefix 400 > synonym 300 > fuzzy 200 > partial 100.
- **Field weights** via `ts_rank_cd` over the weighted tsvector, weights
  `{A,B,C,D} = {1.0, 0.4, 0.2, 0.1}` = title > vendor/type > tags > body,
  scaled by 50 (always < one class step).
- **In-stock boost** +10 (< FIELD_SCALE, so field weight leads availability).
- **Stable tie-break**: `ORDER BY score DESC, title ASC, product_id ASC` — fully
  deterministic. The admin playground shows each product's match class + score
  (ranking explanation). Per-shop weight overrides are intentionally NOT built
  (kept simple; a later phase can add them).

## 5.6 Admin UI

Embedded CRUD pages: `/app/synonyms`, `/app/stopwords`, `/app/redirects`
(session-authenticated, tenant-scoped), plus the Search playground showing
corrections ("showing results for…"), redirect hits, facet counts and the
per-product ranking explanation.

## New tables + RLS (migration 0008)

All four are tenant tables: `shop_id` FK to `shop`, RLS **ENABLED + FORCED**, a
`<table>_tenant_isolation` policy `USING (shop_id = app_current_shop()) WITH
CHECK (shop_id = app_current_shop())`, and `SELECT/INSERT/UPDATE/DELETE` granted
to `app_runtime` (no new privilege; app_runtime stays NOSUPERUSER/NOBYPASSRLS
with no CREATE on the database).

| Table | Purpose | Notes |
|---|---|---|
| `search_vocabulary` | per-shop, per-version terms + doc_freq | FK `index_version_id` ON DELETE CASCADE; GIN trigram on `term` |
| `search_synonym` | per-shop synonyms | `kind` one_way/two_way, `from_term`, `terms[]` |
| `search_stopword` | per-shop stop-word overrides | `mode` add/remove; unique (shop, word) |
| `search_redirect` | per-shop query→destination | unique (shop, query_normalized) |

Migration 0008 adds NO extension (pg_trgm already present) and is
idempotent-from-scratch on PostgreSQL 16 (policies use `DROP POLICY IF EXISTS`
before create so re-application is safe).

## Invariants (independently verifiable)

- Facet counts stay consistent with results under fuzzy/synonym/stop-word
  processing (same `PlannedMatch` powers both) — tested.
- Draft/unpublished products stay excluded everywhere, incl. fuzzy candidates and
  vocabulary — tested (no term leakage).
- Vocabulary and all rules are RLS-isolated per shop — tested (no cross-shop
  suggestions).
- App Proxy signature verification unchanged; shop from the verified signature.
- Index swap/rollback keeps vocabulary in step with the active version — tested.
- All user strings (queries, synonyms, redirects, filters) are parameterised; the
  only SQL text built from tokens are tsquery lexeme strings assembled from
  `[a-z0-9]` tokens (operators are ours), so no injection surface.

## Deviations from the prompt

- **Strategy labels evolved** with the new match model: Phase 3's `and`→`exact`
  and `trigram`→`fuzzy`. Three Phase 3 label assertions were updated (behavioural
  assertions unchanged); no invariant test was weakened.
- **Pure any-term OR** is no longer the primary match; it is retained as the
  `partial` fallback LEVEL, used only when the primary level (exact/prefix/synonym/
  fuzzy) matches nothing — this improves precision while preserving recall.
- **Vocabulary is a full rebuild** of the version after each doc write
  (correctness-first). An incremental doc_freq delta is a Phase 14 optimisation.
- Carried over from Phase 4: price facet is a `priceRange`, availability is a
  counted facet; empty `q` = browse-all.

## Known limitations / REQUIRES VERIFICATION / not tested

- **Performance is not measured** (Phase 14). No latency numbers are claimed. The
  per-write vocabulary rebuild is O(visible docs) — fine for moderate catalogs,
  a known cost at large scale.
- **PostgreSQL-english stop words** are unsearchable via FTS regardless of the
  per-shop layer (documented above).
- **Fuzzy is per token**, not per phrase: a transposition spanning a multi-word
  phrase is corrected token-by-token, not as a phrase.
- **Accent folding** uses JS NFD-strip for the DL comparison and SQL
  `immutable_unaccent` for candidate generation; these agree for Latin diacritics
  (English-first config), not for non-Latin scripts.
- **Per-shop ranking weight overrides** are not built (kept simple).
- The **live Prisma path** for Phase 5 (correction + synonym through the real
  engine) runs on the GitHub Actions workflow; it self-skips in the egress-blocked
  sandbox (same as prior phases). Reported honestly in the Phase 5 report.
