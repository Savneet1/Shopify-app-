# Phase 7 — Theme compatibility notes

The sandbox has no Shopify store or theme, so **no selector or behavior below is
"verified"** — each is a sensible default plus a **Requires Verification** note
to confirm on a real store. The storefront JS never hard-fails on a missing
selector: if `querySelector` finds no input, the predictive enhancement is a
no-op and the theme's native search is untouched.

## Default search-input selector

```
form[action*="/search"] input[name="q"]
```

Rationale (Verified-in-docs): every compliant theme renders its search as
`<form action="{{ routes.search_url }}"><input type="text" name="q" ...></form>`
(docs/PHASE7.md §5). The default selector matches that shape, so it applies to
the reference free themes below without change. The selector is a block setting,
so a merchant can override it for an unusual theme.

## Free OS 2.0 themes (app embed + app block)

| Theme | Search input | Default selector applies? | Results app block |
|---|---|---|---|
| **Dawn** (Shopify reference) | `predictive-search` custom element wrapping `input[name="q"]` on the search form | Yes (matches `name="q"` inside the search form) | `search.json` is a JSON template with a main section → add the **Search results** app block via the theme editor (or the deep link). **Requires Verification** on the live theme. |
| **Refresh** (free, Dawn-derived) | Same Shopify search form shape | Yes | Same as Dawn. **Requires Verification**. |
| **Craft** (free, Dawn-derived) | Same Shopify search form shape | Yes | Same as Dawn. **Requires Verification**. |

Dawn, Refresh and Craft share Shopify's reference search markup, so the default
selector and the `search.json` app-block flow are expected to work unchanged.
Confirm on each live theme (selector match, app-block placement, no style
clashes) before claiming support — **Requires Verification**.

Per-theme overrides a merchant may need (all via block settings, no code):
- a theme whose search input is not inside a `/search` form → set a custom
  `input_selector`;
- a theme/store with a customized App Proxy subpath → set `proxy_prefix` /
  `proxy_subpath`;
- accent/focus colors to match the theme.

## Vintage (pre-OS 2.0) themes

Verified-in-docs: vintage themes have no JSON templates/section groups, so the
**results app block cannot be added** through the theme editor. The **app embed**
(predictive search) still works because it targets `body`.

Documented manual-install path for the results UI on a vintage theme (merchant
or developer, one time):
1. Keep the app embed enabled (predictive search works as-is).
2. In the vintage theme's `templates/search.liquid` (or a custom Liquid
   section), add a container and load the assets:
   ```liquid
   <div id="boost-results-root"></div>
   <script type="application/json" id="boost-results-config">
     { "proxyBase": "/apps/search", "searchUrl": "{{ routes.search_url }}",
       "perPage": 24, "nlEnabled": true, "metafieldKey": "material", "timeoutMs": 2000,
       "labels": { /* copy from extension locales/en.default.json */ } }
   </script>
   {{ 'boost.css' | asset_url | stylesheet_tag }}
   <script src="{{ 'boost-core.js' | asset_url }}" defer></script>
   <script src="{{ 'boost-results.js' | asset_url }}" defer></script>
   ```
   (The assets ship with the extension; on a vintage theme they can also be
   uploaded to the theme's `assets/`.)
3. Best option: upgrade to an Online Store 2.0 theme so the app block installs
   with one click.

Exact behavior on any specific vintage theme is **Requires Verification**.

## What we never do automatically

- We never remove or replace the theme's native results section or Shopify
  routing. The app block renders alongside the theme; fully replacing native
  results is a merchant decision (edit the template) — **Requires Verification**.
- We never activate the app embed on the merchant's behalf (Shopify forbids it);
  we provide a deep link and instructions instead.
