/*
 * Phase 12.4 — pre-order message storefront glue (DISPLAY ONLY).
 *
 * Fetches the applicable pre-order rule for this product from the signed App
 * Proxy and renders a badge + an optional "Ships on <date>" note with
 * textContent only (never innerHTML). Shows nothing when no rule matches; any
 * failure is a silent no-op. Display only — it never changes availability,
 * selling plans or checkout.
 */
(function () {
  "use strict";

  function readConfig(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent || "null"); } catch (e) { return null; }
  }

  // Format an ISO UTC date as a plain local date (no time). The server stores
  // UTC; precise shop-timezone formatting is a display refinement.
  function fmtDate(iso, locale) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    try { return new Date(t).toLocaleDateString(locale || undefined, { year: "numeric", month: "long", day: "numeric" }); }
    catch (e) { try { return new Date(t).toISOString().slice(0, 10); } catch (e2) { return ""; } }
  }

  function render(root, cfg, badge) {
    if (!badge || badge.preorder !== true) return; // nothing to show
    var badgeEl = root.querySelector("[data-boost-preorder-badge]");
    var noteEl = root.querySelector("[data-boost-preorder-note]");
    var labels = cfg.labels || {};
    if (badgeEl) badgeEl.textContent = String(labels.badge || "Pre-order");
    if (noteEl) {
      var note = "";
      if (badge.message) note = String(badge.message);
      else if (badge.releaseAt) {
        var d = fmtDate(badge.releaseAt, cfg.locale);
        if (d) note = String(labels.shipsOn || "Ships on") + " " + d;
      }
      noteEl.textContent = note;
    }
    root.removeAttribute("hidden");
  }

  function load(root, cfg) {
    if (!cfg.productRef) return;
    var base = String(cfg.proxyBase || "/apps/search").replace(/\/+$/, "");
    var url = base + "/preorder?product=" + encodeURIComponent(cfg.productRef);
    var ctrl = null;
    try { if (typeof AbortController === "function") ctrl = new AbortController(); } catch (e) { ctrl = null; }
    var t = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e) {} }, Math.max(500, Number(cfg.timeoutMs) || 2000));
    try {
      fetch(url, { headers: { "Accept": "application/json" }, credentials: "omit", signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { clearTimeout(t); return r && r.ok ? r.json() : null; })
        .then(function (j) { if (j && j.preorder) { try { render(root, cfg, j.preorder); } catch (e) {} } })
        .catch(function () { clearTimeout(t); /* silent no-op */ });
    } catch (e) { clearTimeout(t); /* silent no-op */ }
  }

  function boot() {
    var nodes = document.querySelectorAll("[data-boost-preorder]");
    for (var i = 0; i < nodes.length; i++) {
      var root = nodes[i];
      var cfg = readConfig("boost-preorder-config-" + String(root.id).replace(/^boost-preorder-/, ""));
      if (cfg) { try { load(root, cfg); } catch (e) { /* silent */ } }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
