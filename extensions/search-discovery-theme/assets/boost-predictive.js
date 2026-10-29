/*
 * boost-predictive.js — Phase 7 predictive-search glue (browser only).
 *
 * ADDITIVE enhancement of the theme's EXISTING search input. If this script
 * fails to load or errors, the native <form action="{{ routes.search_url }}">
 * still works. Talks only to the existing App Proxy. Hard ~2s AbortController
 * timeout; on timeout/error/{fallback:"native"} the dropdown stays closed and
 * the native form is used. Renders results with textContent/DOM APIs only
 * (never innerHTML with data). ARIA combobox pattern + full keyboard support.
 *
 * Real-browser behavior is "Requires Verification" (no DOM env in the sandbox);
 * the PURE logic it relies on lives in boost-core.js and is unit-tested.
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.BoostSearch) return;
  var Core = window.BoostSearch;

  function readConfig() {
    var el = document.getElementById("boost-predictive-config");
    if (!el) return null;
    try { return JSON.parse(el.textContent || "{}"); } catch (e) { return null; }
  }

  function t(cfg, key, fallback) {
    return (cfg.labels && typeof cfg.labels[key] === "string") ? cfg.labels[key] : fallback;
  }

  function init() {
    var cfg = readConfig();
    if (!cfg) return;
    var input = null;
    try { input = document.querySelector(cfg.inputSelector || 'form[action*="/search"] input[name="q"]'); }
    catch (e) { input = null; }
    if (!input) return; // nothing to enhance; native search untouched
    var form = input.form || input.closest("form");
    if (!form) return;

    var base = cfg.proxyBase || "/apps/search";
    var listboxId = "boost-predictive-listbox";
    var statusId = "boost-predictive-status";
    var appLocale = Core.resolveLocale(cfg.locale); // Phase 13.2

    // Build the dropdown + live region.
    var wrap = document.createElement("div");
    wrap.className = "boost-predictive";
    var listbox = document.createElement("ul");
    listbox.className = "boost-predictive__list";
    listbox.id = listboxId;
    listbox.setAttribute("role", "listbox");
    listbox.setAttribute("aria-label", t(cfg, "predictiveLabel", "Search suggestions"));
    listbox.hidden = true;
    var status = document.createElement("div");
    status.id = statusId;
    status.className = "boost-visually-hidden";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    wrap.appendChild(listbox);
    wrap.appendChild(status);
    Core.applyLocaleToRoot(wrap, appLocale); // lang/dir on the app's own root only
    if (input.parentNode) input.parentNode.insertBefore(wrap, input.nextSibling);

    // ARIA combobox wiring on the existing input.
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", listboxId);
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("autocomplete", "off");

    var state = { open: false, index: -1 };
    var items = []; // [{type:'product'|'suggestion'|'recent', title, url}]
    var debounce = Core.makeDebouncer();

    // ---- Phase 13.1: interest-based suggestions (client-only, consent-gated) --
    function privacyApi() {
      try { return window.Shopify && window.Shopify.customerPrivacy; } catch (e) { return null; }
    }
    // Merchant switch (default ON); only effective WITH shopper consent. The
    // shopper's own on/off lives inside the interest record (state.enabled).
    function interestOn() { return cfg.personalized !== false; }
    function readInterest() {
      if (!interestOn()) return Core.interestEmpty(Date.now());
      return Core.interestRead(privacyApi(), Date.now());
    }
    function recordSearch(q) {
      if (!interestOn()) return;
      var st = readInterest();
      if (st.enabled === false) return;
      Core.interestWrite(privacyApi(), Core.interestAddSearch(st, q, Date.now()));
    }
    function recordClick(product) {
      if (!interestOn()) return;
      var st = readInterest();
      if (st.enabled === false) return;
      Core.interestWrite(privacyApi(), Core.interestAddClick(st, product, Date.now()));
    }
    // Score a predictive product by the shopper's interest weights (type+vendor).
    function productScore(weights, p) {
      if (!weights || !p) return 0;
      var s = 0;
      if (p.productType != null) s += weights["type:" + String(p.productType).trim().slice(0, 72)] || 0;
      if (p.vendor != null) s += weights["vendor:" + String(p.vendor).trim().slice(0, 72)] || 0;
      return s;
    }
    // Pick a seed query for "Suggested for you": the highest-weighted interest
    // value, else the most recent search. Sent to the EXISTING predictive
    // endpoint as an ordinary query (no new server param).
    function suggestedSeed(st) {
      var keys = Object.keys(st.weights || {});
      if (keys.length) {
        keys.sort(function (a, b) { return (st.weights[b] - st.weights[a]) || (a < b ? -1 : 1); });
        var top = keys[0].split(":");
        if (top.length === 2 && top[1]) return top[1];
      }
      return (st.recent && st.recent.length) ? st.recent[0] : null;
    }

    function setExpanded(open) {
      state.open = open;
      input.setAttribute("aria-expanded", open ? "true" : "false");
      listbox.hidden = !open;
      if (!open) {
        input.removeAttribute("aria-activedescendant");
        state.index = -1;
      }
    }

    function renderActive() {
      var opts = listbox.querySelectorAll('[role="option"]');
      for (var i = 0; i < opts.length; i++) {
        var active = i === state.index;
        opts[i].setAttribute("aria-selected", active ? "true" : "false");
        opts[i].classList.toggle("is-active", active);
        if (active) input.setAttribute("aria-activedescendant", opts[i].id);
      }
      if (state.index < 0) input.removeAttribute("aria-activedescendant");
    }

    // Render the listbox from an explicit items array. Pure DOM; textContent
    // only. `announce` is the count label for the live region.
    function paint(nextItems) {
      while (listbox.firstChild) listbox.removeChild(listbox.firstChild);
      items = nextItems;
      items.forEach(function (it, i) {
        var li = document.createElement("li");
        li.id = "boost-opt-" + i;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        li.className = "boost-predictive__opt boost-predictive__opt--" + it.type;
        li.textContent = it.title; // safe
        li.addEventListener("mousedown", function (ev) { ev.preventDefault(); choose(i); });
        listbox.appendChild(li);
      });
      renderFooter();
      if (items.length > 0) {
        setExpanded(true);
        status.textContent = String(items.length) + " " + t(cfg, "resultsAvailable", "results available");
      } else {
        setExpanded(false);
        status.textContent = t(cfg, "noResults", "No results");
      }
      renderActive();
    }

    // Interest controls live OUTSIDE the listbox (not options): a personalised
    // on/off toggle + "Clear my history". Only shown when the merchant enabled
    // personalisation AND consent is granted (so no control appears when nothing
    // is stored anyway).
    var footer = null;
    function renderFooter() {
      if (footer && footer.parentNode) footer.parentNode.removeChild(footer);
      footer = null;
      if (!interestOn() || !Core.consentAllowsAnalytics(privacyApi())) return;
      var st = readInterest();
      footer = document.createElement("div");
      footer.className = "boost-predictive__footer";
      var toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "boost-predictive__toggle";
      toggle.textContent = st.enabled === false
        ? t(cfg, "personalizeOn", "Turn on personalised suggestions")
        : t(cfg, "personalizeOff", "Turn off personalised suggestions");
      toggle.setAttribute("aria-pressed", st.enabled === false ? "false" : "true");
      toggle.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
        var cur = readInterest();
        cur.enabled = !(cur.enabled !== false) ? true : false; // flip
        Core.interestWrite(privacyApi(), cur);
        onFocusPanel();
      });
      footer.appendChild(toggle);
      if (st.enabled !== false && (st.recent.length || Object.keys(st.weights).length)) {
        var clear = document.createElement("button");
        clear.type = "button";
        clear.className = "boost-predictive__clear";
        clear.textContent = t(cfg, "clearHistory", "Clear my history");
        clear.addEventListener("mousedown", function (ev) {
          ev.preventDefault();
          Core.interestClear();
          onFocusPanel();
        });
        footer.appendChild(clear);
      }
      wrap.appendChild(footer);
    }

    // Query path: fetch results, then re-order (never add/remove) by interest.
    function render(data) {
      var products = (data && Array.isArray(data.products)) ? data.products : [];
      var suggestions = (data && Array.isArray(data.suggestions)) ? data.suggestions : [];
      var st = readInterest();
      var enabled = interestOn() && st.enabled !== false;
      var mapped = [];
      products.forEach(function (p) {
        var path = Core.toSameSitePath(p.url, cfg.allowedHosts, window.location.hostname);
        if (!path) return; // drop any non-allowed URL
        mapped.push({ type: "product", title: p.title || "", url: path, gid: p.gid, _p: p });
      });
      // Stable, deterministic re-order ONLY — the set is unchanged.
      if (enabled) {
        mapped = Core.interestReorder(mapped, function (it) { return productScore(st.weights, it._p); });
      }
      var out = mapped;
      suggestions.forEach(function (s) {
        out.push({ type: "suggestion", title: (s && s.text) || "", url: null });
      });
      paint(out);
    }

    // Empty-focus panel: "Recent searches" + "Suggested for you" (the latter via
    // the EXISTING predictive endpoint as an ordinary query — no new param).
    function onFocusPanel() {
      if (!interestOn() || !Core.consentAllowsAnalytics(privacyApi())) { setExpanded(false); renderFooter(); return; }
      var st = readInterest();
      if (st.enabled === false) { paint([]); return; }
      var recent = (st.recent || []).slice(0, Core.INTEREST_MAX_RECENT).map(function (q) {
        return { type: "recent", title: q, url: null };
      });
      paint(recent); // show recent immediately
      var seed = suggestedSeed(st);
      if (seed) {
        fetchPredictive(seed, function (data) {
          var products = (data && Array.isArray(data.products)) ? data.products : [];
          var sugg = [];
          products.forEach(function (p) {
            var path = Core.toSameSitePath(p.url, cfg.allowedHosts, window.location.hostname);
            if (path) sugg.push({ type: "suggestion", title: p.title || "", url: path, gid: p.gid, _p: p });
          });
          paint(recent.concat(sugg));
        });
      }
    }

    function emitAnalytics(ev) {
      if (cfg.analytics !== true) return;
      try { if (window.BoostAnalytics) window.BoostAnalytics.track(base, ev); } catch (e) {}
    }

    function choose(i) {
      var it = items[i];
      if (!it) return;
      if (it.type === "product" && it.url) {
        emitAnalytics({ eventType: "predictive_click", surface: "predictive", query: (input.value || "").trim(), productGid: it.gid });
        recordClick(it._p || { title: it.title }); // interest weight (client-only)
        window.location.assign(it.url); // already a validated same-site path
      } else {
        // suggestion OR recent-search chip: fill + submit the native form.
        emitAnalytics({ eventType: "suggestion_click", surface: "predictive", query: it.title });
        input.value = it.title;
        submitNative();
      }
    }

    function submitNative() {
      setExpanded(false);
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    }

    // Consent-gated (H1): only read the A/B token when A/B is enabled AND the
    // Shopify customer-privacy API grants analytics consent (fail-closed).
    // Predictive never creates a token — only the results block does, lazily.
    function visitorToken() {
      if (cfg.abTesting === false) return null;
      if (!Core.consentAllowsAnalytics(privacyApi())) return null; // consent-guarded read of boost_abt
      try { return Core.sanitizeToken(window.localStorage.getItem("boost_abt")); } catch (e) { return null; }
    }
    function fetchPredictive(q, onData) {
      var url = Core.buildProxyUrl(base, "predictive", { q: q });
      var abt = visitorToken();
      if (abt) url += (url.indexOf("?") >= 0 ? "&" : "?") + "abt=" + encodeURIComponent(abt);
      if (appLocale) url += (url.indexOf("?") >= 0 ? "&" : "?") + "locale=" + encodeURIComponent(appLocale); // Phase 13.2 hint

      var controller = ("AbortController" in window) ? new AbortController() : null;
      var timedOut = false;
      var timer = window.setTimeout(function () {
        timedOut = true;
        if (controller) controller.abort();
      }, cfg.timeoutMs || 2000);
      fetch(url, { signal: controller ? controller.signal : undefined, headers: { Accept: "application/json" } })
        .then(function (res) {
          window.clearTimeout(timer);
          if (!res.ok) { if (Core.decideFallback({ httpError: true })) setExpanded(false); return null; }
          return res.json().catch(function () { return null; });
        })
        .then(function (body) {
          if (body == null) return;
          if (Core.decideFallback({ body: body })) { setExpanded(false); return; }
          if (onData) onData(body); else render(body);
        })
        .catch(function () {
          window.clearTimeout(timer);
          // timeout or network error: never block native search.
          setExpanded(false);
          if (timedOut) status.textContent = "";
        });
    }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      if (q.length === 0) { onFocusPanel(); return; } // empty → interest panel
      debounce(function () { fetchPredictive(q); }, cfg.debounceMs || 150);
    });

    // Focus with an empty box opens the interest panel (recent + suggested).
    input.addEventListener("focus", function () {
      if (input.value.trim().length === 0) onFocusPanel();
    });

    // Record the typed query as a recent search when the native form submits.
    form.addEventListener("submit", function () {
      var q = (input.value || "").trim();
      if (q.length > 0) recordSearch(q);
    });

    input.addEventListener("keydown", function (ev) {
      var next = Core.comboboxKey(state, ev.key, items.length);
      if (next.action === "none") return;
      if (next.action === "submit") return; // let the form submit natively
      ev.preventDefault();
      state.index = next.index;
      if (next.action === "close") { setExpanded(false); return; }
      if (next.action === "select") { choose(next.index); return; }
      if (next.action === "move") { setExpanded(true); renderActive(); }
    });

    document.addEventListener("click", function (ev) {
      if (!wrap.contains(ev.target) && ev.target !== input) setExpanded(false);
    });
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      wrap.classList.add("boost-reduced-motion");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
