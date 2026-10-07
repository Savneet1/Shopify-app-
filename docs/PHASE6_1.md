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

## Tests

Full sandbox suite: **Test Files 24 passed (24), Tests 208 passed | 6 skipped
(214)** — up from 195 passed | 6 skipped. **+13**: 7 pure-parser cases in
`phase6-units` (A1 block: thousands/`~`/`between`, reject-don't-truncate,
year/count/unit guards, currency-overrides-year) and 6 engine cases in the new
`phase6_1` file (A2 `"red"`→`"Red"`, draft-only value not applied, cross-shop
isolation; A3 `negationIgnored` + warning; A4 NUL with `nl` on and off; and
NL == manual-equivalent for products, total and facets). The 6 skips are the
`prisma-integration` cases that self-skip in the egress-blocked sandbox and run
on CI. `typecheck` 0 errors; `build` and `worker:build` OK.

All 195 prior tests pass unchanged. The `phase6-units` fixture gained `tagValues`
/ `metafieldValues` so its existing attribute assertions reflect the live-value
resolution A2 adds — no assertion was changed or weakened.

## Known limitations / not tested / unsure

- **No performance numbers** (Phase 14). A2 adds two small per-request context
  queries (distinct live tag values + configured-metafield values) alongside the
  existing vendor/type fetch.
- Price parsing is English-first and rule-based; exotic phrasings outside the
  documented cues fall through to free text (safe).
- Live-Prisma execution of the Phase 6/6.1 path runs on CI and self-skips in the
  egress-blocked sandbox — honestly unverified here, verified on GitHub Actions.

## Next step

Push these Phase 6.1 changes (fast-forward on `3b14ad2`) and run
`.github/workflows/live-prisma-check.yml`. It applies the existing migrations and
runs the full non-skipped suite through the real Prisma engine. Send the run URL;
the live results will confirm the sandbox pg-verification.

STATUS: PHASE 6.1 IMPLEMENTED & PG-VERIFIED. LIVE-PRISMA CONFIRMATION PENDING.
PHASE 7 NOT STARTED. AWAITING LIVE-PRISMA RUN AND EXPLICIT USER APPROVAL.
