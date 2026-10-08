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
    if (input.parentNode) input.parentNode.insertBefore(wrap, input.nextSibling);

    // ARIA combobox wiring on the existing input.
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", listboxId);
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("autocomplete", "off");

    var state = { open: false, index: -1 };
    var items = []; // [{type:'product'|'suggestion', title, url}]
    var debounce = Core.makeDebouncer();

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

    function render(data) {
      // textContent/DOM only — never innerHTML with API data.
      while (listbox.firstChild) listbox.removeChild(listbox.firstChild);
      items = [];
      var products = (data && Array.isArray(data.products)) ? data.products : [];
      var suggestions = (data && Array.isArray(data.suggestions)) ? data.suggestions : [];
      var count = 0;
      products.forEach(function (p) {
        // Real API url is Shopify's absolute onlineStoreUrl; convert to a
        // same-site relative path via the allowlist (fail-closed).
        var path = Core.toSameSitePath(p.url, cfg.allowedHosts, window.location.hostname);
        if (!path) return; // drop any non-allowed URL
        items.push({ type: "product", title: p.title || "", url: path });
      });
      suggestions.forEach(function (s) {
        items.push({ type: "suggestion", title: (s && s.text) || "", url: null });
      });
      items.forEach(function (it, i) {
        var li = document.createElement("li");
        li.id = "boost-opt-" + i;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        li.className = "boost-predictive__opt boost-predictive__opt--" + it.type;
        li.textContent = it.title; // safe
        li.addEventListener("mousedown", function (ev) { ev.preventDefault(); choose(i); });
        listbox.appendChild(li);
        count++;
      });
      if (count > 0) {
        setExpanded(true);
        status.textContent = String(count) + " " + t(cfg, "resultsAvailable", "results available");
      } else {
        setExpanded(false);
        status.textContent = t(cfg, "noResults", "No results");
      }
      renderActive();
    }

    function choose(i) {
      var it = items[i];
      if (!it) return;
      if (it.type === "product" && it.url) {
        window.location.assign(it.url); // already a validated same-site path
      } else {
        input.value = it.title;
        submitNative();
      }
    }

    function submitNative() {
      setExpanded(false);
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    }

    function visitorToken() {
      try { return window.localStorage.getItem("boost_abt"); } catch (e) { return null; }
    }
    function fetchPredictive(q) {
      var url = Core.buildProxyUrl(base, "predictive", { q: q });
      var abt = visitorToken();
      if (abt) url += (url.indexOf("?") >= 0 ? "&" : "?") + "abt=" + encodeURIComponent(abt);
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
          render(body);
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
      if (q.length === 0) { setExpanded(false); return; }
      debounce(function () { fetchPredictive(q); }, cfg.debounceMs || 150);
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
