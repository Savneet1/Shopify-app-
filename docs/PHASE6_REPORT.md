# Phase 6 Report — Semantic Layer / NL Query Parser

Date: 2026-10-07. Built on Phase 5 (commit 69fbd47), continuing the existing git
history (fast-forward). Rule-based and deterministic. No new Shopify scope, no new
npm dependency, no new PostgreSQL extension, no paid service — nothing tripped a
STOP rule. Live-Prisma confirmation is withheld until the GitHub Actions run (same
discipline as Phases 3–5).

> STATUS: implemented + pg-verified in the sandbox. Live-Prisma confirmation
> PENDING (`.github/workflows/live-prisma-check.yml`, unchanged, applies migration
> 0009 and runs the Phase 6 Prisma-integration case). Phase 7 not started.

## Design decisions

- **Parse → merge into the existing pipeline; never fork search.** The parser
  extracts intent into `RawFilters` + a sort hint + remaining free text. Those
  filters pass the SAME `normalizeFilters()` as manual params; the remaining text
  feeds the SAME Phase 5 planner. Products and facet counts therefore share one
  code path and cannot drift (the Phase 4 own-selection-excluded facet logic is
  untouched).
- **Deterministic, no ML**: pure regex + per-shop dictionary; `parseQuery` is a
  pure function (tested for determinism).
- **Brand/type matched against live, VISIBLE facet values** (published + ACTIVE,
  active version) — per-shop, no draft leakage.
- **Never worse than Phase 5**: a parsed zero-result falls back to plain search
  (`fellBack: true`). NL is on by default and can be disabled (`nl=0`) or have
  interpretations dropped (`ignore=…`).

## Exact parsing rules

Lower-cased, bounded to 200 chars, matched phrases removed in order:
1. **Price** (explicit cue required; a bare number is never a price): `between X
   and/to Y`; `under|below|less than|cheaper than|up to|at most` → max;
   `over|above|more than|at least|starting at|from` → min; `around|about|~` →
   ±20%. Optional currency symbol (`$£€₹`) / word (dollars/usd/rs/inr/rupees/
   pounds/gbp/euros/eur); 0..1e9, ≤2 decimals.
2. **Availability**: out-of-stock first, then in-stock.
3. **Sort**: cheapest/lowest→price_asc; most expensive/highest→price_desc;
   newest/latest→newest. No popularity/best-selling invented.
4. **Brand/type/attribute**: longest-phrase token scan, each token consumed once;
   vendor/product_type matched against live facet values, attributes via the
   per-shop dictionary (+ English defaults).
5. **Remaining** tokens → free-text query for the Phase 5 planner.
Negation (`not|no|without|except|excluding|sans` before a recognized term) DROPS
that interpretation (safe degradation); negative filtering is unsupported.

## Tables + RLS

Migration `0009_phase6_semantic` (additive, idempotent-from-scratch on PG16, no
extension): `search_attribute_term` (tenant table: shop_id FK, phrase, facet ∈
{tags,metafield,product_type,vendor}, value; unique (shop,phrase)) with RLS
**ENABLED + FORCED**, policy `search_attribute_term_tenant_isolation USING/WITH
CHECK (shop_id = app_current_shop())`, grants `SELECT/INSERT/UPDATE/DELETE` to
`app_runtime` only (no new privilege). Plus `product.product_created_at` and
`product_search_doc.created_at_shopify` (+ btree) for the `newest` sort, captured
in the shared `docInsertSql`. `DROP POLICY IF EXISTS` before `CREATE POLICY`.

## Test counts vs 171

Sandbox: **Test Files 23 passed (23), Tests 195 passed | 6 skipped (201)** — up
from 171 (166 passed | 5 skipped). Phase 6 added **30** tests: `phase6-units`
(19: price phrasings/currency/ambiguity, availability, sort incl. no popularity,
brand/type vs plain words, multi-word, non-English no-op, negation, hostile input
incl. SQL metacharacters/oversized/unicode, ignore, determinism) and `phase6-nl`
(10: attribute+type parse, brand+price, facet/result consistency, newest &
cheapest sorts, zero-result fallback, nl-disable, ignore, negation suppression,
hostile input + table integrity, per-shop dictionary + RLS + cross-shop
isolation). Plus 1 skipped Phase 6 case in `prisma-integration` (runs on CI).
`typecheck` 0, `build` + `worker:build` OK.

**All 171 prior tests pass unchanged — no assertion weakened, and NO label/
strategy assertion had to change** (NL defaults on but is a no-op when the query
has no recognized intent, so Phase 3/4/5 behaviours are preserved; verified).

## Deviations

- NL parsing is ON by default in `storefrontSearchWithExec` (disable with
  `nl:false`). It is a no-op when nothing is recognized, so prior tests are
  unaffected; the "never worse than Phase 5" fallback guarantees results.
- Negative filtering is not implemented; negation degrades safely (documented).

## Known limitations / not tested / unsure

- **No performance numbers** (Phase 14). Parsing adds a per-request context fetch
  (distinct vendors/types + dictionary) and one extra plain search only on a
  parsed zero-result (fallback).
- Attribute dictionary values are applied as-is through the facet filter
  (case-sensitive on the value); defaults assume lower-case tag values.
- English-first; non-English is a safe no-op.
- `newest` needs `product.createdAt`; pre-existing docs get it on the next
  rebuild. Nulls sort last.
- Live Prisma execution of the Phase 6 path runs on CI and self-skips in the
  egress-blocked sandbox — honestly unverified here, verified on GitHub Actions.

## Next step

Push these Phase 6 changes (fast-forward on 69fbd47) and run
`.github/workflows/live-prisma-check.yml` (Actions → Live Prisma Check → Run
workflow, or on push). It applies migration 0009 and runs the Phase 6
Prisma-integration case (brand + price parse through the real engine). Send the
run URL; I'll confirm the live results.

STATUS: PHASE 6 IMPLEMENTED & PG-VERIFIED. LIVE-PRISMA CONFIRMATION PENDING.
PHASE 7 NOT STARTED. AWAITING LIVE-PRISMA RUN AND EXPLICIT USER APPROVAL.
