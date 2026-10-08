# Phase 7 Report — Storefront / Theme App Extension

Built on Phase 6.1b (commit `495db56`), continuing the existing git history
(fast-forward). Rule-based/deterministic. **No** new Shopify scope, **no** new
npm dependency, **no** new PostgreSQL extension, **no** migration, **no** schema
change. `docInsertSql` stays the single source of truth; the one query planner
still drives search and facets. Live-store/theme behavior is **Requires
Verification** (this sandbox has no Shopify store or theme); the full docs-
verification record is `docs/PHASE7.md`.

> STATUS: implemented + pg-verified/unit-verified in the sandbox. Live-Prisma
> confirmation PENDING (`.github/workflows/live-prisma-check.yml`, unchanged).
> Phase 8 not started.

## Design decisions

- **Additive, never destructive.** The theme's native search form keeps working
  if JS is blocked, fails to load, times out, or the API returns
  `{fallback:"native"}`. The app block renders *alongside* the theme's results;
  we never remove the theme's results section or touch Shopify routing.
- **App embed for predictive, app block for results.** The predictive dropdown
  is an app embed (target `body`) so it works on vintage *and* OS 2.0 themes by
  enhancing the theme's existing `name="q"` input. The results UI is an app block
  (target `section`) requiring the OS 2.0 `search.json` JSON template. (docs §2.)
- **Proxy-only, no new endpoints, no browser signing.** Storefront JS calls the
  existing App Proxy (`/apps/search/{products|predictive|suggest}`) with relative
  `fetch`. The HMAC signature is verified server-side as before (Phase 3); the
  browser never signs. (docs §4.)
- **One shared pure core.** `assets/boost-core.js` is a UMD module (browser
  global + Node `require`) holding all framework-free logic (URL-state
  serialize/parse, proxy-URL build, same-site URL validation, timeout/fallback
  decision, ARIA combobox keyboard state). The DOM glue
  (`boost-predictive.js`, `boost-results.js`) consumes it. The core is unit-
  tested in Node; the DOM glue is **Requires Verification** (no DOM library was
  added — see Tests).
- **Never trust the URL.** `parseState` validates and bounds every param against
  the SAME limits as the API (q≤200, ≤50 values/group, ≤100 chars/value, price
  0–1e9, page≥1, sort ∈ known set, `ignore` ⊂ known kinds), so a hostile URL can
  never push an out-of-range value to the proxy.

## Exact behavior

- **URL state (7.3):** `q, vendor, productType, tags, metafield, priceMin,
  priceMax, available, collectionId, sort, page, nl, ignore` live in the query
  string. `serializeState` is deterministic (stable key order, sorted multi-
  values, defaults omitted) so URLs are shareable; `popstate` re-reads and re-
  renders so back/forward work. `page` is converted to `limit`/`offset` for the
  products endpoint and never sent raw.
- **Timeout → native (7.2):** each request uses `AbortController` with a hard
  ~2s timeout (configurable). `decideFallback` returns true on timeout, non-OK
  HTTP, missing/invalid body, or `{fallback:"native"}`; predictive then closes
  the dropdown, results shows a notice with a working link to `routes.search_url`.
- **Interpreted-as chips (7.1):** each Phase 6 interpretation renders a chip with
  a remove button that adds its `kind` to `ignore` and re-queries; the typo
  `correctedQuery` indicator, the `negationIgnored` **warning**, the `fellBack`
  note, zero-result **suggestions** (re-query on click), and **redirect**
  (client navigates only when `isSafeUrl` passes) are all rendered.
- **Security (7.6):** all API data is written via `textContent`/DOM APIs (never
  `innerHTML`); every product URL, image URL and the redirect destination is
  passed through `isSafeUrl` (root-relative, non-protocol-relative, no scheme,
  no control chars) before use; no inline event handlers, no `eval`, config
  passed via a `type="application/json"` script block (not executable); no
  secrets or PII in theme code.
- **Mobile (7.4) & a11y (7.5):** responsive grid (2→3 cols), off-canvas filter
  drawer under 750px, ≥44px touch targets; ARIA combobox (`role=combobox`,
  `aria-expanded`, `aria-controls`, `aria-activedescendant`, `role=listbox/
  option`), Up/Down/Home/End/Enter/Escape handling, a polite live region for
  result counts and interpreted-as changes, visible `:focus-visible` outlines,
  `prefers-reduced-motion` respected, no color-only meaning (text labels on
  state).
- **Admin (7.8):** `/app/storefront` shows install steps, theme-editor deep
  links (app embed + app block, built from `shop` + `SHOPIFY_API_KEY` + block
  handles), and a real status check (active index? visible-doc count? proxy path
  ready?). No new scope: "enabled in theme?" is merchant-driven (we do not
  request `read_themes`).

## Corrections (pre-existing wiring gaps found during Phase 7)

`app/routes.ts` is an **explicit** route table (the fs-routes convention is not a
dependency). The App Proxy endpoints (`proxy.products/predictive/suggest.tsx`)
and the Phase 3–6 admin pages (`app.search/attributes/redirects/stopwords/
synonyms.tsx`) existed on disk but were **never registered** there, so they were
unreachable over HTTP. (CI did not catch this: the suite and worker exercise the
search engine directly, not route resolution.) Phase 7 **registers** them, plus
the new `app.storefront.tsx`. This is wiring of already-committed files — no new
feature, scope, or dependency. The build now transforms 62 modules (was 35),
confirming the routes compile in. Live HTTP behavior remains **Requires
Verification** (no running Shopify context here).

## Tests vs 218

Full sandbox suite: **Test Files 25 passed (25), Tests 242 passed | 6 skipped
(248)** — up from 218 passed | 6 skipped. **+24** in `test/phase7-core.test.ts`
(all Node, no DOM library added):
- `parseState` defaults + hostile/out-of-range rejection + caps + control-char
  stripping + comma/repeat multi-values;
- `serializeState` round-trip + determinism + default omission;
- `buildProxyUrl` limit/offset from page, page-param dropped, base trim;
- `isSafeUrl` accepts root-relative, rejects absolute/protocol-relative/scheme/
  junk;
- `decideFallback` timeout/http/missing/native vs normal body;
- `comboboxKey` ArrowUp/Down wrap, Home/End, Escape close, Enter select/submit,
  no-op when closed;
- locale **key parity** (en/fr, strings + schema) via `scripts/check-locale-
  parity.mjs`;
- theme app extension **static validity**: each block's `{% schema %}` is valid
  JSON with the right `target` and a <25-char name; required files present;
  `type="theme"`; every `t:`-label used by a block exists in the schema locale;
  every storefront `| t` key used by the results block exists in `en.default.json`.

All 218 prior tests pass unchanged — none weakened. `typecheck` 0 errors;
`build` OK (62 modules); `worker:build` OK.

## Deviations

- No DOM test library is installed and none was added (per the brief). The pure
  logic is fully unit-tested; DOM rendering/focus/fetch is **Requires
  Verification** (see list).
- Routes-table correction above (registering pre-existing files).
- README previously read "Phase 6.1b"; it is now brought current to Phase 7.

## Requires Verification (real store / theme / browser)

- Deep-link URLs actually opening the theme editor and adding/activating the
  blocks (needs a deployed extension so `api_key`/handles resolve).
- The app block rendering on a real `search.json`; the default input selector
  matching Dawn/Refresh/Craft; no visual clashes.
- End-to-end proxy reachability from a storefront page; the native fallback
  firing on a real timeout.
- DOM behaviors: predictive dropdown rendering/keyboard/focus, results grid/
  facets/pagination, filter drawer, live-region announcements, `popstate`
  back/forward, redirect navigation.
- Vintage-theme behavior and the manual-install path (docs/PHASE7_THEME_COMPAT.md).
- Merchant-customized App Proxy subpath.

## Next step

Push these Phase 7 changes (fast-forward on `495db56`), deploy the app so the
theme app extension and App Proxy are live, then run
`.github/workflows/live-prisma-check.yml` for the backend confirmation and
manually verify the storefront items above on a dev store with Dawn. Send the run
URL; backend live results will confirm the sandbox verification.

STATUS: PHASE 7 IMPLEMENTED & SANDBOX-VERIFIED. LIVE-PRISMA + LIVE-STORE
CONFIRMATION PENDING. PHASE 8 NOT STARTED. AWAITING LIVE RUN AND EXPLICIT USER
APPROVAL.
