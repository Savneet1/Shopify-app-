/*
 * boost-recommendations.js — Phase 9 storefront glue for the Recommendations
 * app block. Framework-free; renders with textContent + DOM node APIs only
 * (never raw markup from API data). Pure logic lives in boost-core.js.
 *
 * Privacy:
 *  - "Recently viewed" is first-party browser storage (localStorage key
 *    boost_recent). It is written/read ONLY behind the Shopify customer-privacy
 *    analytics-consent gate (Core.consentAllowsAnalytics, fail-closed) AND
 *    inside try/catch. Without consent, nothing is stored and no `recent`
 *    param is sent. The server never stores it.
 *  - The view/click beacon (proxy/rec-event) increments an AGGREGATE per-product
 *    counter with NO visitor identifier, so it carries no personal data; it is
 *    advisory only (public + inflatable).
 *  - On any failure/timeout/empty payload the block renders nothing (no layout
 *    shift) — it only ever ADDS a shelf, never breaks the page.
 */
(function () {
  var Core = (typeof window !== "undefined" && window.BoostSearch) || null;
  if (!Core || typeof document === "undefined") return;

  var RECENT_KEY = "boost_recent";
  var SEED_TYPES = { similar: 1, related: 1, fbt: 1 };

  function readConfigs() {
    var out = [];
    var nodes = document.querySelectorAll('script[id^="boost-recs-config-"]');
    for (var i = 0; i < nodes.length; i++) {
      try { out.push(JSON.parse(nodes[i].textContent || "{}")); } catch (e) { /* skip */ }
    }
    return out;
  }

  function currentHost() {
    try { return window.location && window.location.hostname; } catch (e) { return ""; }
  }

  function privacyApi() {
    try { return window.Shopify && window.Shopify.customerPrivacy; } catch (e) { return null; }
  }
  function consentOk() {
    return Core.consentAllowsAnalytics(privacyApi());
  }

  // ---- recently-viewed (consent-gated, try/catch everywhere) ----
  function readRecent() {
    if (!consentOk()) return [];
    try { return Core.parseRecentIds(window.localStorage.getItem(RECENT_KEY)); } catch (e) { return []; }
  }
  function recordRecent(ref) {
    if (!consentOk()) return;
    try {
      var next = Core.pushRecentId(window.localStorage.getItem(RECENT_KEY), ref);
      window.localStorage.setItem(RECENT_KEY, Core.serializeRecentIds(next));
    } catch (e) { /* storage unavailable → no-op */ }
  }
  function clearRecent() { try { window.localStorage.removeItem(RECENT_KEY); } catch (e) {} }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function beacon(cfg, ref, type) {
    if (!ref) return;
    var u = String(cfg.proxyBase || "/apps/search").replace(/\/+$/, "") +
      "/rec-event?product=" + encodeURIComponent(ref) + "&type=" + encodeURIComponent(type);
    try {
      if (navigator && typeof navigator.sendBeacon === "function") navigator.sendBeacon(u);
      else fetch(u, { method: "POST", keepalive: true }).catch(function () {});
    } catch (e) { /* beacons never block the UI */ }
  }

  function cardLink(cfg, p) {
    var href = Core.toSameSitePath(p.url, cfg.allowedHosts, currentHost());
    if (!href && p.handle) {
      var h = Core.normalizeRef(p.handle);
      if (h) href = "/products/" + encodeURIComponent(h);
    }
    return href; // may be null → render a non-link card
  }

  function renderCard(cfg, p) {
    var href = cardLink(cfg, p);
    var card = el(href ? "a" : "div", "boost-recs__card");
    if (href) {
      card.setAttribute("href", href);
      card.addEventListener("click", function () { beacon(cfg, p.gid || p.handle, "click"); });
    }
    // image (validated; never navigation)
    if (p.image && Core.isSafeImageUrl(p.image.url, cfg.imageHosts)) {
      var img = el("img", "boost-recs__img");
      img.setAttribute("src", p.image.url);
      img.setAttribute("alt", p.image.alt || p.title || "");
      img.setAttribute("loading", "lazy");
      card.appendChild(img);
    }
    card.appendChild(el("div", "boost-recs__title", p.title || ""));
    if (cfg.showVendor && p.vendor) card.appendChild(el("div", "boost-recs__vendor", p.vendor));
    if (cfg.showPrice) {
      var price = Core.formatPrice(p.priceMin, p.priceMax, cfg.currency);
      if (price) card.appendChild(el("div", "boost-recs__price", price));
    }
    if (p.available === false) {
      card.appendChild(el("div", "boost-recs__oos", (cfg.labels && cfg.labels.outOfStock) || "Out of stock"));
    }
    return card;
  }

  function fetchJson(url, timeoutMs) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (controller) controller.abort(); },
      Math.max(500, Math.min(Number(timeoutMs) || 2000, 5000)));
    return fetch(url, { signal: controller ? controller.signal : undefined, headers: { Accept: "application/json" } })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) return { __fallback: true };
        return res.json().then(function (body) { return { body: body }; }, function () { return { __fallback: true }; });
      })
      .catch(function () { clearTimeout(timer); return { __fallback: true, timedOut: timedOut }; });
  }

  function initBlock(cfg) {
    var root = document.getElementById(cfg.rootId);
    if (!root) return;
    var grid = root.querySelector("[data-boost-recs-grid]");
    if (!grid) return;
    var type = String(cfg.type || "trending");

    // Seed-requiring shelves need a seed; without one, render nothing.
    if (SEED_TYPES[type] && !cfg.seed && !cfg.seedGid) return;

    // Record + beacon the CURRENT product view (product page seed).
    if (cfg.seedGid) {
      beacon(cfg, cfg.seedGid, "view");
      if (cfg.trackRecent !== false && cfg.seed) recordRecent(cfg.seed);
    }
    // If consent was later withdrawn, drop any stored list.
    if (!consentOk()) clearRecent();

    var base = String(cfg.proxyBase || "/apps/search").replace(/\/+$/, "");
    var params = [];
    params.push("type=" + encodeURIComponent(type));
    if (cfg.seed) params.push("seed=" + encodeURIComponent(cfg.seed));
    var limit = Math.max(1, Math.min(12, Math.floor(Number(cfg.count) || 8)));
    params.push("limit=" + limit);
    var recent = readRecent();
    if (recent.length) params.push("recent=" + encodeURIComponent(recent.join(",")));
    var url = base + "/recommendations?" + params.join("&");

    fetchJson(url, cfg.timeoutMs).then(function (r) {
      if (!r || r.__fallback) return;             // silent no-op
      if (Core.decideFallback({ body: r.body })) return;
      var products = (r.body && Array.isArray(r.body.products)) ? r.body.products : [];
      if (products.length === 0) return;          // nothing to show → no shelf
      if (cfg.columns) grid.style.setProperty("--boost-recs-cols", String(Math.max(2, Math.min(6, Number(cfg.columns) || 4))));
      var frag = document.createDocumentFragment();
      for (var i = 0; i < products.length; i++) frag.appendChild(renderCard(cfg, products[i]));
      grid.appendChild(frag);
      root.hidden = false;                        // reveal only once populated
    });
  }

  function init() {
    var cfgs = readConfigs();
    for (var i = 0; i < cfgs.length; i++) initBlock(cfgs[i]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
