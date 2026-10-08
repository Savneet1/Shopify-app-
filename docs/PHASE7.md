# Phase 7 — Shopify docs verification (Storefront / Theme App Extension)

Date: 2026-10-08. Sources are `shopify.dev` via the Shopify docs MCP
(`search_docs_chunks`) on 2026-10-08. Each item is tagged **Verified-in-docs**
(the docs state it) or **Requires Verification** (only confirmable on a real
store/theme — this sandbox has no Shopify store or theme). No API detail here is
invented; where the docs did not show an exact string, it is marked.

## 1. Theme app extensions — structure & limits

**Verified-in-docs.** A theme app extension lives under `extensions/<name>/` with:
`assets/` (CSS/JS/static), `blocks/` (app block + app embed block `.liquid`),
`snippets/`, `locales/` (`en.default.json`, `en.default.schema.json`, plus other
locales), `package.json`, and `shopify.extension.toml`.
Source: /docs/apps/build/online-store/theme-app-extensions/configuration.

`shopify.extension.toml` for a theme extension is minimal:
```toml
name = "..."
type = "theme"     # always "theme" for a theme app extension
handle = "..."      # optional; a per-extension reference (separate from block handles)
```
**Verified-in-docs** (same page). A block's own handle comes from its Liquid
filename.

Assets inject into themes either via the `javascript`/`stylesheet` schema
attributes (auto `<script async>` / `<link rel=stylesheet>` when the block is on
the page; de-duplicated if referenced by several blocks) or via
`asset_url`/`asset_img_url` Liquid filters. **Verified-in-docs.**

## 2. App block vs app embed block

**Verified-in-docs.**
- **App block** — `target: "section"`. Injects inline content into a section.
  Requires an OS 2.0 theme: a **JSON template** with a **section that renders
  `{% content_for 'blocks' %}` / accepts `{"type":"@app"}` blocks**. Merchants
  add it in the theme editor (Apps). Schema supports `name` (<25 chars, no app
  name in it), `target`, `javascript`, `stylesheet`, `settings`, and
  `enabled_on`/`available_if` template gating.
- **App embed block** — `target: "head" | "body" | "compliance_head"`. Injected
  before `</head>`/`</body>`. **Deactivated by default**; the app cannot activate
  it — the merchant enables it under Theme settings → App embeds (a deep link
  helps). Only has the **Global Liquid scope** of the page. **Works on vintage
  AND OS 2.0 themes** because it does not rely on sections/JSON templates.

Design decision (ours): the predictive-search enhancement ships as an **app embed
block** (works everywhere, enhances the theme's own search input); the
search-results UI ships as an **app block** (needs the OS 2.0 `search.json`
template / a section accepting `@app`).

## 3. Online Store 2.0 JSON templates

**Verified-in-docs.** JSON templates list sections + settings; the theme editor
can add/remove/reorder them. Limits: **up to 25 sections per template, 50 blocks
per section**; up to 1,000 JSON templates per theme. `search.json` and
`collection.json` are standard template types. App blocks only work in JSON
templates whose sections opt into `@app`; `@app` blocks are **not** supported in
statically-rendered sections. Source: /docs/.../templates/json-templates,
/docs/.../blocks/app-blocks.

## 4. App Proxy from storefront JS

**Verified-in-docs.** A storefront request to `/{prefix}/{subpath}/...` (ours:
`/apps/search/...`) is proxied to the app, with Shopify appending `shop`,
`path_prefix`, `timestamp`, `logged_in_customer_id` and a SHA-256 HMAC
`signature`. **The signature can only be verified server-side** (needs the app
secret) — our existing `authenticate.public.appProxy` does this (Phase 3,
unchanged). So storefront JS just calls the **relative** proxy URL; it performs
no signing. One proxy route per app. Source:
/docs/apps/build/online-store/app-proxies(/authenticate-app-proxies),
/docs/api/shopify-app-react-router/v0/authenticate/public/app-proxy.

Design decision: the storefront JS computes the proxy base from the app embed/app
block settings (prefix + subpath, default `apps`/`search`) and calls
`/{prefix}/{subpath}/products|predictive|suggest` with `fetch`. No new endpoints;
no signing in the browser. The merchant can change the proxy subpath/prefix, so
these are block settings (defaults `apps`/`search`). **Requires Verification:** a
merchant who customized the proxy subpath must set it in the block settings — the
real proxied path is confirmable only on a store.

## 5. Predictive / search behavior; native fallback target

**Verified-in-docs.** The theme search form is
`<form action="{{ routes.search_url }}"><input type="text" name="q" ...></form>`
→ submits to the storefront `/search?q=...`. Shopify also offers a native
Predictive Search Ajax API at `GET /{locale}/search/suggest.json?q=...`. We do
**not** use Shopify's predictive API — we call our own proxy — but the **native
fallback** target is the theme's `routes.search_url` form submit. Our JS enhances
the existing form and, on timeout/error/`{fallback:"native"}`, submits it
natively. Source: /docs/.../templates/search, /docs/api/ajax/reference/predictive-search.

## 6. What can / cannot be replaced on search & collection pages

**Verified-in-docs (capability) / Requires Verification (per theme).**
- An app block can be **added** to a section that accepts `@app` on the
  `search.json` (and `collection.json`) template; it renders **alongside** the
  theme's own results section. We do **not** remove or replace the theme's native
  results — the merchant chooses whether to keep both. Fully replacing the
  theme's results section requires the merchant to edit the template (remove the
  native main-search section) — **Requires Verification** per theme, and never
  done automatically by the app.
- Storefront filtering already uses URL params and **collections > 5,000 products
  don't display (native) filters**; our facets come from our own proxy, not the
  native filter object. **Verified-in-docs** (native filter note).
- A client-side redirect from our API must navigate only to a **validated
  same-site** destination (see Phase 7.6). The app never replaces Shopify routing.

## 7. Vintage (pre-OS 2.0) themes

**Verified-in-docs.** Vintage themes have **no JSON templates / section groups**,
so **app blocks cannot be used**. Only **app embed blocks** work there. Therefore
on a vintage theme the predictive enhancement (app embed) still works, but the
search-results app block cannot be added through the theme editor. Documented
manual-install path (Phase 7.7): the merchant pastes the app block's snippet /
the embed is enabled, or upgrades to an OS 2.0 theme. **Requires Verification:**
exact behavior on any specific vintage theme.

## 8. Deep links (admin → theme editor)

**Verified-in-docs (param names) / Requires Verification (assembled URL on a real
store).** Post-install deep links open the theme editor to add/activate a block.
Query params documented:
- **App block:** `.../admin/themes/current/editor?template={template}&addAppBlockId={api_key}/{handle}&target={sectionId:<id>|mainSection|header|footer|aside}`.
  (`uuid` is deprecated in favor of `api_key` = the app `client_id`; `{handle}` =
  the block's Liquid filename.)
- **App embed:** `.../admin/themes/current/editor?context=apps&template={template}&...` activating the embed by `{api_key}/{handle}`.
Source: /docs/.../theme-app-extensions/configuration (Deep linking). The admin
page builds these from `shop`, `client_id` and the block handles; the exact live
behavior is **Requires Verification** (needs a real store + deployed extension so
the extension id / `api_key` exist).

## 9. Scopes

**Verified-in-docs / decision.** Theme app extensions themselves need **no access
scope**. Detecting whether a merchant has added the app block / enabled the app
embed can be done with `app.extensions()` from the embedded admin — **no extra
scope**. Reading theme files to verify compatibility server-side would need
`read_themes`; we **deliberately do not** request it (no new scope — global rule),
so the admin "is the app enabled in the theme?" check is **merchant-driven /
Requires Verification** rather than server-detected. The App Proxy is already
configured (Phase 3); no new scope is introduced by Phase 7.

## Summary table

| Item | Status |
|---|---|
| TAE directory layout + `shopify.extension.toml` (`type="theme"`) | Verified-in-docs |
| App block `target:section`, needs OS2.0 JSON template/section `@app` | Verified-in-docs |
| App embed `target:head/body`, off by default, vintage-compatible | Verified-in-docs |
| Schema attrs (name<25, javascript, stylesheet, settings, enabled_on) | Verified-in-docs |
| Locales `en.default.json` + `en.default.schema.json` | Verified-in-docs |
| JSON template limits (25 sections/50 blocks) | Verified-in-docs |
| App Proxy relative call from JS; server-only signature verify | Verified-in-docs |
| Native fallback = theme `routes.search_url` form submit | Verified-in-docs |
| Deep-link param names (`addAppBlockId`, `target`, `template`, `api_key`, `context=apps`) | Verified-in-docs |
| Assembled deep-link URL working on a real store | Requires Verification |
| App block renders on a real `search.json`; selector matches a real theme | Requires Verification |
| Vintage-theme exact behavior / manual install | Requires Verification |
| Merchant-customized proxy subpath path | Requires Verification |
| In-admin block-activation detection via `app.extensions()` | Requires Verification |
| No new scope required | Verified-in-docs + decision |
