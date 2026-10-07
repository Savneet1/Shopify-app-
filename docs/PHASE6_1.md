# Phase 6.1 Report — NL Query Parser fix batch

Date: 2026-10-07. Built on Phase 6 (commit `3b14ad2`), continuing the existing
git history (fast-forward). Rule-based and deterministic. **No** new Shopify
scope, **no** new npm dependency, **no** new PostgreSQL extension, **no** new
migration, **no** schema change, **no** new indexed field, **no** paid service —
nothing tripped a STOP rule. `docInsertSql` remains the single source of truth
for indexed fields; one query planner still drives search AND facets.

> STATUS: implemented + pg-verified in the sandbox (node-postgres, same SQL as
> production Prisma via the `Exec` abstraction). Live-Prisma confirmation is
> PENDING (`.github/workflows/live-prisma-check.yml`, unchanged). Phase 7 not
> started.

This batch fixes five defects found by independent probes. Each has a regression
test; **no prior assertion was weakened**.

## A1 — Price parsing (`app/lib/search/nlparse.ts`)

A money amount is now matched by one regex (`AMT`) and validated AFTER matching
by `amountInfo`, so an out-of-range number is rejected **whole** rather than
partially consumed. `notAPrice` suppresses non-price numbers; ambiguous cues are
gated.

| Input | Before (defect) | After |
|---|---|---|
| `under $1,000` | comma broke the match / `max 1` | `priceMax = 1000`, remainder empty |
| `~100`, `shoes ~100` | `~` cue missed (a `\b` sat before `~`) | `priceMin 80 … priceMax 120` (±20%); `shoes ~100` leaves `shoes` |
| `under 12345678` | truncated to `1234567` + orphan `8` | whole number taken: `priceMax = 12345678`, remainder empty |
| `under 99.999` | truncated to `99.99` + orphan `9` | **rejected** (>2 decimals): no price filter, digits survive as free text |
| `under 9999999999` | — | **rejected** (>9 integer digits): no price filter |
| `between 10-50` | required spaces around the dash | `priceMin 10 … priceMax 50` (hyphen or en/em dash, with or without spaces) |
| `from 2020 collection` | `priceMin = 2020` | no price (plausible year, no currency marker) |
| `at least 2 colors` | `priceMin = 2` | no price (count word `colors`) |
| `for over 18s` | `priceMin = 18` | no price (no-space unit suffix `s`) |
| `under 100ml bottle` | `priceMax = 100` | no price (no-space unit `ml`) |
| `from $2020` | — | `priceMin = 2020` (currency marker overrides the year rule) |

Rules, precisely:
- **Amount**: optional currency symbol (`$ £ € ₹`) or word (dollars/usd/rs/inr/
  rupees/pounds/gbp/euros/eur); integer plain or with thousands commas
  (`1,000`); optional decimal. Rejected whole when the integer part exceeds **9
  digits**, the decimal exceeds **2 places**, or the value exceeds `1e9`.
- **Non-price numbers**: a number immediately followed by a unit/count word —
  `ml l oz kg g lb mm cm m inch in gb tb pack pcs piece(s) color(s) star(s)
  year(s) yr`, or a no-space unit suffix including `…s` (`18s`) — is never a
  price.
- **Ambiguous cues** (`from over above at least more than up to`) apply only when
  the number carries a currency symbol/word, or is **not** a plausible year
  (1900–2100). **Unambiguous cues** (`under below less than cheaper than at most`,
  `between … and/to/-`) are unchanged.
- Extraction iterates (≤3 passes) so a query can carry both a min and a max.

## A2 — Case-insensitive attribute values (`nlparse.ts`)

`buildParseContext` now also fetches the **live, visible** tag values and the
configured-metafield values (published + `status='ACTIVE'`, active version — the
SAME visibility as the vendor/product_type lists) and builds a case-insensitive
lookup (`ciMap`: lower-case → live casing; lexicographically-first casing wins on
collision, so it stays deterministic).

When an attribute phrase maps to a `tags` or `metafield` facet, `applyEntry`
resolves the value case-insensitively against those live values and applies the
**live casing**. If there is no live match the phrase is **not applied** — it
stays free text and feeds the Phase 5 planner (so `"red"` still recalls via FTS).

Result: `"red"` finds a product tagged `"Red"` and applies `tags = Red`. A
tag value that exists only on a draft/unpublished product is never applied
(no draft leakage), and the live values are per-shop (cross-shop isolated).
Negation recognition stays at the dictionary level (independent of live
resolution), so `"not red"` is still flagged (see A3).

## A3 — Negation transparency (`storefront.ts`, `app/routes/app.search.tsx`)

Negative filtering remains intentionally unsupported, but the response now
carries a machine-readable flag and a human-readable note:

```jsonc
interpretedAs: {
  // …
  negations: ["red"],
  negationIgnored: ["red"],                         // ← machine-readable (A3)
  warning: "Negative filtering isn't supported yet, so \"red\" was ignored."
}
```

`negationIgnored` mirrors `negations` but is named for UI consumption; `warning`
is `null` when nothing was negated. The admin playground renders the warning as
an inline `role="alert"` banner inside the "Interpreted as" panel. Both survive
the zero-result fallback (`fellBack` does not clear them).

## A4 — Control characters (`text.ts`, `query.ts`, `filters.ts`)

`stripControl` removes C0 control characters (`U+0000`–`U+001F`, including NUL)
and `U+007F` in the **shared** normalization path, so a NUL byte can never reach
PostgreSQL (which rejects it: `invalid byte sequence 0x00`). It is applied to the
query (`normalizeParams`) and to free-text filter values (`toArray`,
`collectionId`), for **both** `nl: true` and `nl: false`. A NUL-containing query
now returns results normally instead of erroring.

## Phase 6.1b — follow-up fixes (built on `583ea81`)

A second small fix batch on three defects independent probes found after 6.1.
Same global rules: no migration, schema change, new indexed field, scope,
dependency or extension.

### B1 — mixed-case duplicate facet values (`nlparse.ts`)

6.1's `ciMap` kept a single casing per lower-cased key, so a shop holding the
same value in several casings had products silently excluded.

| Setup | Query | Before (defect) | After |
|---|---|---|---|
| products tagged `red`, `Red`, `RED` | `red` | only the one `red`-tagged product (Phase 5 plain search would have found all three) | all three; `tags = red (3 casings)`; `appliedFilters.tags = [RED, Red, red]` |
| metafield `Leather` + `LEATHER` | `leather` | one casing | both applied |
| vendors `Nike` + `NIKE` | `nike` | one casing | both applied |
| `red` live, `RED` draft-only | `red` | — | only `red` (no draft leakage) |
| shop A `RED`, shop B `red` | `red` | — | each shop sees only its own casing (no cross-tenant leak) |

`ciMapMulti` now maps a key → **all** live casings (de-duplicated,
lexicographically sorted → deterministic). The facet group is OR-within-group, so
applying all casings widens correctly. Done for tags, the configured metafield,
vendor and product_type. Still live-visible values only (published + `ACTIVE`,
active version); no live match ⇒ not applied (stays free text); per-shop isolated.

### B2 — malformed thousands grouping (`nlparse.ts`)

Commas are accepted only in proper grouping (1–3 digits, then groups of exactly
3). After matching, an amount immediately followed by a digit (`1,0000`→`0`) or a
comma-then-digit (`1,00`→`,00`) is a malformed number and is rejected whole.

| Input | Before | After |
|---|---|---|
| `under 1,00` | `priceMax 1` (+ stray text) | **no price**, text unchanged |
| `under 1,0000` | `priceMax 1000` (+ stray `0`) | **no price**, text unchanged |
| `under $1,000` | 1000 | 1000 (unchanged) |
| `under 1000` | 1000 | 1000 (unchanged) |
| `under 12,345.50` | — | `priceMax 12345.50` |

### B3 — ambiguous cues over plain nouns (`nlparse.ts`)

For the **ambiguous** cues only (`from over above at least more than up to`)
without a currency marker, the number is a price only if it is the last token, or
is followed by a currency word or a recognised vendor/product_type/attribute
phrase; any other plain word means it is not a price. **Unambiguous** cues
(`under below less than cheaper than between…and around/about/~`) are unchanged.

| Input | Before | After |
|---|---|---|
| `up to 5 people` | `priceMax 5` | no price |
| `up to 50` | 50 | `priceMax 50` (last token) |
| `up to 50 nike shoes` | 50 | `priceMax 50` (vendor follows) |
| `from $20 jackets` | 20 | `priceMin 20` (currency marker) |
| `over 1500` | 1500 | `priceMin 1500` (last token) |
| `from 2020 collection` | none | none (year, unchanged) |

## Tests

Full sandbox suite: **Test Files 24 passed (24), Tests 218 passed | 6 skipped
(224)**. The journey: 195 (Phase 6) → **+13** (6.1) → **+10** (6.1b) = 218.
- 6.1 added 7 pure (`phase6-units` A1) + 6 engine (`phase6_1` A2/A3/A4 + NL==manual).
- 6.1b added 5 pure (`phase6-units`: B2 grouping; B3 last-token / follow-word /
  unambiguous-not-gated) + 5 engine (`phase6_1` B1: three-casing tags + NL==manual,
  two-casing metafield, two-casing vendor, draft-only casing not applied, cross-shop
  no-leak).

The 6 skips are the `prisma-integration` cases that self-skip in the
egress-blocked sandbox and run on CI. `typecheck` 0 errors; `build` and
`worker:build` OK. **All 208 prior tests pass unchanged** — the `phase6-units`
fixture's `tagValues`/`metafieldValues` became `…: string[]` to match the
all-casings `ParseContext`, with the same asserted outputs (no assertion changed
or weakened).

## Known limitations / not tested / unsure

- **No performance numbers** (Phase 14). A2/B1 add small per-request context
  queries (distinct live tag + configured-metafield values) alongside the
  existing vendor/type fetch.
- Price parsing is English-first and rule-based; exotic phrasings outside the
  documented cues fall through to free text (safe).
- B3's "recognised phrase" check matches the first following token against the
  set of known vendor/type/attribute first-tokens — a lightweight heuristic, not
  a full phrase parse.
- Live-Prisma execution of the Phase 6/6.1/6.1b path runs on CI and self-skips in
  the egress-blocked sandbox — honestly unverified here, verified on GitHub Actions.

## Next step

Push these changes (fast-forward on `583ea81`) and run
`.github/workflows/live-prisma-check.yml`. It applies the existing migrations and
runs the full non-skipped suite through the real Prisma engine. Send the run URL;
the live results will confirm the sandbox pg-verification.

STATUS: PHASE 6.1b IMPLEMENTED & PG-VERIFIED. LIVE-PRISMA CONFIRMATION PENDING.
PHASE 7 NOT STARTED. AWAITING LIVE-PRISMA RUN AND EXPLICIT USER APPROVAL.
