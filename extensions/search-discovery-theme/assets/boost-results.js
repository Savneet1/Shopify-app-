/*
 * boost-results.js — Phase 7 search-results app block glue (browser only).
 *
 * Renders results grid, facets, sort, pagination, "interpreted as" chips (each
 * removable via the Phase 6 ignore/nl params), the typo-correction indicator,
 * the negationIgnored warning, zero-result suggestions, and redirect handling
 * (navigates only to a validated same-site destination). State lives in the URL
 * query string (q/filters/sort/page/nl/ignore); back/forward works; every URL
 * param is validated+bounded by boost-core (never trusted). All API data is
 * rendered via textContent/DOM APIs (never innerHTML). Hard ~2s timeout; on
 * timeout/error/{fallback:"native"} it shows a message and leaves a working link
 * to the theme's native /search.
 *
 * Real-browser behavior is "Requires Verification"; the pure logic is in
 * boost-core.js (unit-tested).
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.BoostSearch) return;
  var Core = window.BoostSearch;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function t(cfg, key, fallback) {
    return (cfg.labels && typeof cfg.labels[key] === "string") ? cfg.labels[key] : fallback;
  }

  function init() {
    var root = document.getElementById("boost-results-root");
    if (!root) return;
    var cfg;
    try { cfg = JSON.parse((document.getElementById("boost-results-config") || {}).textContent || "{}"); }
    catch (e) { return; }
    var base = cfg.proxyBase || "/apps/search";
    var perPage = Math.max(1, Math.min(60, Math.floor(Number(cfg.perPage) || 24)));
    var nlDefault = cfg.nlEnabled !== false;

    // Scaffold: controls, live region, facets (drawer on mobile), grid.
    root.textContent = "";
    var live = el("div", "boost-visually-hidden");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    var notice = el("div", "boost-results__notice");
    notice.hidden = true;
    var bannerBox = el("div", "boost-banners");
    var showBanners = cfg.banners !== false; // merchant toggle (default on)
    var interp = el("div", "boost-results__interpreted");
    var layout = el("div", "boost-results__layout");
    var facetsPanel = el("aside", "boost-facets");
    facetsPanel.setAttribute("aria-label", t(cfg, "filters", "Filters"));
    var main = el("div", "boost-results__main");
    var toolbar = el("div", "boost-results__toolbar");
    var grid = el("ul", "boost-results__grid");
    grid.setAttribute("role", "list");
    var pager = el("nav", "boost-results__pager");
    pager.setAttribute("aria-label", t(cfg, "pagination", "Pagination"));
    main.appendChild(toolbar);
    main.appendChild(grid);
    main.appendChild(pager);
    layout.appendChild(facetsPanel);
    layout.appendChild(main);
    root.appendChild(live);
    root.appendChild(notice);
    if (showBanners) root.appendChild(bannerBox);
    root.appendChild(interp);
    root.appendChild(layout);

    var state = Core.parseState(new URLSearchParams(window.location.search));
    if (!nlDefault) state.nl = false;

    // Anonymous A/B token, CONSENT-GATED (H1). A token is only ever created or
    // read when A/B is enabled AND the Shopify customer-privacy API grants
    // analytics consent (fail-closed via Core.consentAllowsAnalytics). Without
    // consent we send no token (the server assigns control) and delete any
    // stored token. The token is created LAZILY — only after a response shows a
    // running experiment — so a first view is always control. No PII, no IP, no
    // fingerprinting. Consent API specifics are Requires Verification.
    var abEnabled = cfg.abTesting !== false; // merchant toggle (default on)
    var exposed = {}; // experimentId -> true (one exposure beacon per load)
    var lastExperiments = [];

    function privacyApi() {
      try { return window.Shopify && window.Shopify.customerPrivacy; } catch (e) { return null; }
    }
    function consentOk() {
      return abEnabled && Core.consentAllowsAnalytics(privacyApi());
    }
    function readToken() {
      if (!consentOk()) return null; // consent-guarded read of boost_abt
      try { return Core.sanitizeToken(window.localStorage.getItem("boost_abt")); } catch (e) { return null; }
    }
    function makeToken() {
      if (!consentOk()) return null; // consent-guarded create of boost_abt
      try {
        var v = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
        v = Core.sanitizeToken(v);
        if (v) window.localStorage.setItem("boost_abt", v);
        return v;
      } catch (e) { return null; }
    }
    function clearToken() { try { window.localStorage.removeItem("boost_abt"); } catch (e) { /* ok */ } }

    // Current token to send: none unless consent is granted; without consent we
    // also delete any previously stored token.
    function currentToken() {
      if (!consentOk()) { clearToken(); return null; }
      return readToken();
    }
    // Lazily create the token once a running experiment is seen (applies from
    // the NEXT request, so the first view stays control). No experiments → never.
    function maybeCreateToken(data) {
      if (!consentOk()) return;
      var exps = (data && Array.isArray(data.experiments)) ? data.experiments : [];
      if (exps.length > 0 && !readToken()) makeToken();
    }
    // Re-evaluate once when consent is collected; if not granted, drop the token.
    try {
      document.addEventListener("visitorConsentCollected", function () {
        if (!consentOk()) clearToken();
      }, { once: true });
    } catch (e) { /* ok */ }

    function announce(msg) { live.textContent = ""; live.textContent = msg; }

    function withToken(url) {
      var abt = currentToken();
      return abt ? url + (url.indexOf("?") >= 0 ? "&" : "?") + "abt=" + encodeURIComponent(abt) : url;
    }

    function beacon(experimentId, variant, type) {
      var u = base.replace(/\/+$/, "") + "/merch-event?experiment=" + encodeURIComponent(experimentId) +
        "&variant=" + encodeURIComponent(variant) + "&type=" + encodeURIComponent(type);
      try {
        if (navigator && typeof navigator.sendBeacon === "function") navigator.sendBeacon(u);
        else fetch(u, { method: "POST", keepalive: true }).catch(function () {});
      } catch (e) { /* beacons never block the UI */ }
    }

    function recordExposures(data) {
      if (!abEnabled) return;
      var exps = (data && Array.isArray(data.experiments)) ? data.experiments : [];
      exps.forEach(function (x) {
        if (!x || !x.experimentId || exposed[x.experimentId]) return;
        exposed[x.experimentId] = true;
        beacon(x.experimentId, x.variant || "control", "exposure");
      });
    }
    function recordClicks(data) {
      if (!abEnabled) return;
      var exps = (data && Array.isArray(data.experiments)) ? data.experiments : [];
      exps.forEach(function (x) { if (x && x.experimentId) beacon(x.experimentId, x.variant || "control", "click"); });
    }

    function pushState(replace) {
      var qs = Core.serializeState(state);
      var url = window.location.pathname + (qs ? "?" + qs : "");
      if (replace) window.history.replaceState({ boost: true }, "", url);
      else window.history.pushState({ boost: true }, "", url);
    }

    function nativeSearchHref() {
      var sp = new URLSearchParams();
      if (state.q) sp.set("q", state.q);
      return (cfg.searchUrl || "/search") + "?" + sp.toString();
    }

    function showNotice(msg, withNativeLink) {
      notice.hidden = false;
      notice.textContent = "";
      notice.appendChild(el("span", null, msg));
      if (withNativeLink) {
        var a = el("a", "boost-results__native-link", t(cfg, "useNative", "Use standard search"));
        a.href = nativeSearchHref();
        notice.appendChild(document.createTextNode(" "));
        notice.appendChild(a);
      }
    }

    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    // ---- interpreted-as chips (remove -> ignore kind / toggle nl) ----
    function renderInterpreted(data) {
      clear(interp);
      var ia = data && data.interpretedAs;
      if (!ia || !ia.applied) return;
      if (data.corrected && data.correctedQuery) {
        var corr = el("p", "boost-correction");
        corr.appendChild(el("span", null, t(cfg, "showingFor", "Showing results for") + " "));
        corr.appendChild(el("strong", null, data.correctedQuery));
        interp.appendChild(corr);
      }
      var chips = el("ul", "boost-chips");
      chips.setAttribute("aria-label", t(cfg, "interpretedAs", "Interpreted as"));
      (ia.interpreted || []).forEach(function (item) {
        var li = el("li", "boost-chip");
        li.appendChild(el("span", "boost-chip__text", item.detail || item.text || ""));
        var btn = el("button", "boost-chip__remove", "×");
        btn.type = "button";
        btn.setAttribute("aria-label", t(cfg, "remove", "Remove") + ": " + (item.text || item.kind));
        btn.addEventListener("click", function () {
          if (state.ignore.indexOf(item.kind) < 0) state.ignore.push(item.kind);
          state.page = 1;
          apply();
        });
        li.appendChild(btn);
        chips.appendChild(li);
      });
      if (ia.fellBack) chips.appendChild(el("li", "boost-chip boost-chip--note", t(cfg, "fellBack", "Simplified to plain search")));
      interp.appendChild(chips);
      if (ia.warning) {
        var warn = el("p", "boost-warning");
        warn.setAttribute("role", "note");
        warn.textContent = ia.warning;
        interp.appendChild(warn);
      }
    }

    // ---- facets ----
    var FIELD_FOR = { vendor: "vendor", productType: "productType", tags: "tags" };
    function fieldForFacet(key) {
      if (key === (cfg.metafieldKey || "material")) return "metafield";
      if (key === "available") return "available";
      return FIELD_FOR[key] || key;
    }
    function isChecked(field, value) {
      var arr = state[field];
      return Array.isArray(arr) && arr.indexOf(value) >= 0;
    }
    function renderFacets(data) {
      clear(facetsPanel);
      var facets = (data && Array.isArray(data.facets)) ? data.facets : [];
      if (facets.length === 0) return;
      var heading = el("h2", "boost-facets__title", t(cfg, "filters", "Filters"));
      facetsPanel.appendChild(heading);
      facets.forEach(function (facet) {
        var field = fieldForFacet(facet.key);
        if (field === "available") return; // availability handled as a toolbar select
        var group = el("fieldset", "boost-facet");
        group.appendChild(el("legend", "boost-facet__legend", facet.label || facet.key));
        (facet.options || []).forEach(function (opt) {
          var id = "boost-f-" + field + "-" + Math.random().toString(36).slice(2, 8);
          var label = el("label", "boost-facet__opt");
          label.htmlFor = id;
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.id = id;
          cb.checked = isChecked(field, opt.value);
          cb.addEventListener("change", function () {
            var arr = Array.isArray(state[field]) ? state[field].slice() : [];
            if (cb.checked) { if (arr.indexOf(opt.value) < 0) arr.push(opt.value); }
            else { arr = arr.filter(function (v) { return v !== opt.value; }); }
            state[field] = arr;
            state.page = 1;
            apply();
          });
          label.appendChild(cb);
          label.appendChild(document.createTextNode(" " + (opt.label || opt.value) + " (" + (opt.count || 0) + ")"));
          group.appendChild(label);
        });
        facetsPanel.appendChild(group);
      });
    }

    // ---- banners (textContent + validated image/link only) ----
    function renderBanners(data) {
      if (!showBanners) return;
      clear(bannerBox);
      var banners = (data && Array.isArray(data.banners)) ? data.banners : [];
      banners.forEach(function (b) {
        if (!b) return;
        var box = el("div", "boost-banner");
        var inner = el("div", "boost-banner__inner");
        if (b.imageUrl && Core.isSafeImageUrl(b.imageUrl, cfg.imageHosts)) {
          var img = document.createElement("img");
          img.className = "boost-banner__img";
          img.src = b.imageUrl; img.alt = ""; img.loading = "lazy";
          inner.appendChild(img);
        }
        var txt = el("div", "boost-banner__text");
        if (b.title) txt.appendChild(el("div", "boost-banner__title", b.title)); // textContent
        if (b.body) txt.appendChild(el("div", "boost-banner__body", b.body));     // textContent
        inner.appendChild(txt);
        var linkPath = b.linkPath ? Core.toSameSitePath(b.linkPath, cfg.allowedHosts, window.location.hostname) : null;
        if (linkPath) { var a = el("a", "boost-banner__link"); a.href = linkPath; a.appendChild(inner); box.appendChild(a); }
        else box.appendChild(inner);
        bannerBox.appendChild(box);
      });
    }

    // ---- toolbar: result count + sort + availability ----
    function renderToolbar(data) {
      clear(toolbar);
      var count = el("p", "boost-results__count");
      count.textContent = String(data.total || 0) + " " + t(cfg, "results", "results");
      toolbar.appendChild(count);

      var sortWrap = el("label", "boost-results__sort");
      sortWrap.appendChild(el("span", "boost-visually-hidden", t(cfg, "sortBy", "Sort by")));
      var sel = document.createElement("select");
      [["relevance", t(cfg, "sortRelevance", "Relevance")],
       ["price_asc", t(cfg, "sortPriceAsc", "Price: low to high")],
       ["price_desc", t(cfg, "sortPriceDesc", "Price: high to low")],
       ["newest", t(cfg, "sortNewest", "Newest")]].forEach(function (o) {
        var opt = document.createElement("option");
        opt.value = o[0]; opt.textContent = o[1];
        if (state.sort === o[0]) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", function () { state.sort = sel.value; state.page = 1; apply(); });
      sortWrap.appendChild(sel);
      toolbar.appendChild(sortWrap);
    }

    // ---- grid ----
    var locale = (document.documentElement && document.documentElement.lang) || undefined;
    function money(p) {
      return Core.formatPrice(p.priceMin, p.priceMax, cfg.currency, locale);
    }
    function renderGrid(data) {
      clear(grid);
      var products = (data && Array.isArray(data.products)) ? data.products : [];
      products.forEach(function (p) {
        var li = el("li", "boost-card");
        var a = el("a", "boost-card__link");
        // Absolute onlineStoreUrl -> same-site relative path (allowlist); fall
        // back to the native search page only if the URL is not allowed.
        var path = Core.toSameSitePath(p.url, cfg.allowedHosts, window.location.hostname);
        a.href = path || nativeSearchHref();
        if (p.image && Core.isSafeImageUrl(p.image.url, cfg.imageHosts)) {
          var img = document.createElement("img");
          img.className = "boost-card__img";
          img.src = p.image.url; // absolute CDN URL, host-allowlisted
          img.alt = p.image.alt || p.title || "";
          img.loading = "lazy";
          a.appendChild(img);
        }
        a.appendChild(el("span", "boost-card__title", p.title || ""));
        var meta = el("span", "boost-card__meta");
        if (p.vendor) meta.appendChild(el("span", "boost-card__vendor", p.vendor));
        var pr = money(p);
        if (pr) meta.appendChild(el("span", "boost-card__price", pr));
        if (!p.available) meta.appendChild(el("span", "boost-card__oos", t(cfg, "outOfStock", "Out of stock")));
        a.appendChild(meta);
        // A click on a result is a click for every active experiment variant.
        a.addEventListener("click", function () { recordClicks({ experiments: lastExperiments }); });
        li.appendChild(a);
        grid.appendChild(li);
      });
      if (products.length === 0) {
        var empty = el("p", "boost-results__empty", t(cfg, "noProducts", "No products matched."));
        grid.appendChild(empty);
        renderSuggestions(data);
      }
    }

    function renderSuggestions(data) {
      var sugg = (data && Array.isArray(data.suggestions)) ? data.suggestions : [];
      if (sugg.length === 0) return;
      var box = el("div", "boost-suggestions");
      box.appendChild(el("h3", "boost-suggestions__title", t(cfg, "tryInstead", "Try one of these")));
      var ul = el("ul", "boost-suggestions__list");
      sugg.forEach(function (s) {
        var li = el("li");
        var b = el("button", "boost-suggestion", (s && s.text) || "");
        b.type = "button";
        b.addEventListener("click", function () { state.q = (s && s.text) || ""; state.page = 1; apply(); });
        li.appendChild(b);
        ul.appendChild(li);
      });
      box.appendChild(ul);
      grid.appendChild(box);
    }

    // ---- pagination ----
    function renderPager(data) {
      clear(pager);
      var total = data.total || 0;
      var pages = Math.max(1, Math.ceil(total / perPage));
      if (pages <= 1) return;
      var mkBtn = function (label, page, disabled, current) {
        var b = el("button", "boost-page" + (current ? " is-current" : ""), label);
        b.type = "button";
        if (disabled) b.disabled = true;
        if (current) b.setAttribute("aria-current", "page");
        b.addEventListener("click", function () { state.page = page; apply(true); });
        return b;
      };
      pager.appendChild(mkBtn(t(cfg, "prev", "Previous"), Math.max(1, state.page - 1), state.page <= 1, false));
      var span = el("span", "boost-page__info");
      span.textContent = t(cfg, "page", "Page") + " " + state.page + " / " + pages;
      pager.appendChild(span);
      pager.appendChild(mkBtn(t(cfg, "next", "Next"), Math.min(pages, state.page + 1), state.page >= pages, false));
    }

    // ---- fetch + apply ----
    var inflight = 0;
    function apply(focusGrid) {
      pushState(false);
      run(focusGrid);
    }

    function run(focusGrid) {
      notice.hidden = true;
      var myReq = ++inflight;
      var url = withToken(Core.buildProxyUrl(base, "products", state, perPage));
      var controller = ("AbortController" in window) ? new AbortController() : null;
      var timedOut = false;
      var timer = window.setTimeout(function () { timedOut = true; if (controller) controller.abort(); }, cfg.timeoutMs || 2000);
      announce(t(cfg, "loading", "Loading results…"));
      fetch(url, { signal: controller ? controller.signal : undefined, headers: { Accept: "application/json" } })
        .then(function (res) {
          window.clearTimeout(timer);
          if (!res.ok) return { __fb: true };
          return res.json().catch(function () { return { __fb: true }; });
        })
        .then(function (data) {
          if (myReq !== inflight) return; // a newer request superseded this one
          if (data && data.__fb) { fallback(); return; }
          if (Core.decideFallback({ body: data })) { fallback(); return; }
          // Redirect: navigate only to a validated same-site destination
          // (Phase 5 may return an absolute same-domain URL -> converted to a
          // relative path so it stays on the visitor's origin).
          if (data.redirect) {
            var rpath = Core.toSameSitePath(data.redirect, cfg.allowedHosts, window.location.hostname);
            if (rpath) { window.location.assign(rpath); return; }
          }
          lastExperiments = (data && Array.isArray(data.experiments)) ? data.experiments : [];
          maybeCreateToken(data); // lazily create the token once an experiment is running (next request)
          renderBanners(data);
          renderInterpreted(data);
          renderFacets(data);
          renderToolbar(data);
          renderGrid(data);
          renderPager(data);
          recordExposures(data); // one aggregate exposure beacon per experiment per load
          var msg = String(data.total || 0) + " " + t(cfg, "results", "results");
          var ia = data.interpretedAs;
          if (ia && ia.applied && ia.warning) msg += ". " + ia.warning;
          announce(msg);
          if (focusGrid) { var f = grid.querySelector("a,button"); if (f) f.focus(); }
        })
        .catch(function () {
          window.clearTimeout(timer);
          if (myReq !== inflight) return;
          fallback();
        });
    }

    function fallback() {
      showNotice(t(cfg, "unavailable", "Search is temporarily unavailable."), true);
      announce(t(cfg, "unavailable", "Search is temporarily unavailable."));
    }

    window.addEventListener("popstate", function () {
      state = Core.parseState(new URLSearchParams(window.location.search));
      if (!nlDefault) state.nl = false;
      run(false);
    });

    // Mobile filter drawer toggle (progressive; CSS drives the sheet).
    var toggle = document.getElementById("boost-filter-toggle");
    if (toggle) {
      toggle.addEventListener("click", function () {
        var open = root.classList.toggle("boost-drawer-open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) { var first = facetsPanel.querySelector("input,button,select"); if (first) first.focus(); }
      });
    }

    run(false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
