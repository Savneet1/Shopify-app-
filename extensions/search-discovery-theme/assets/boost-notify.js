/*
 * Phase 12.2 — "Notify me when available" storefront glue.
 *
 * Renders NOTHING from server data as markup: every dynamic value is written
 * with textContent (never innerHTML), so a hostile title/label can never inject
 * markup. The form is shown ONLY when the current variant (or the product) is
 * unavailable; when available it stays hidden (silent no-op). On submit it
 * validates an email + an explicit (unchecked-by-default) consent box, POSTs a
 * JSON body to the signed App Proxy, and shows a GENERIC status either way — it
 * never reveals whether the address is already subscribed. Any failure shows a
 * generic error and never blocks the page.
 */
(function () {
  "use strict";

  var EMAIL_RE = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]{2,}$/;

  function readConfig(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent || "null"); } catch (e) { return null; }
  }

  function currentVariantGid(cfg) {
    try {
      var p = new URLSearchParams(window.location.search).get("variant");
      if (p && /^[0-9]+$/.test(p)) return "gid://shopify/ProductVariant/" + p;
    } catch (e) { /* ignore */ }
    return null;
  }

  // Is the selected target (variant if known, else product) currently
  // unavailable? Fail-closed to "available" (hide) when we cannot tell, so the
  // form never shows for an in-stock item.
  function isUnavailable(cfg) {
    var vgid = currentVariantGid(cfg);
    if (vgid && Array.isArray(cfg.variants)) {
      for (var i = 0; i < cfg.variants.length; i++) {
        if (cfg.variants[i] && cfg.variants[i].gid === vgid) return cfg.variants[i].available === false;
      }
    }
    // No specific variant selected: product-level availability.
    return cfg.productAvailable === false;
  }

  function setStatus(node, msg) { if (node) node.textContent = String(msg || ""); }

  function init(root, cfg) {
    var form = root.querySelector("[data-boost-notify-form]");
    var emailEl = root.querySelector("[data-boost-notify-email]");
    var consentEl = root.querySelector("[data-boost-notify-consent]");
    var submitEl = root.querySelector("[data-boost-notify-submit]");
    var statusEl = root.querySelector("[data-boost-notify-status]");
    if (!form || !emailEl || !consentEl) return;
    var labels = cfg.labels || {};

    // Show only when the target is unavailable; otherwise leave hidden.
    function sync() {
      if (isUnavailable(cfg)) root.removeAttribute("hidden");
      else root.setAttribute("hidden", "");
    }
    sync();
    // Re-evaluate when the shopper switches variant (URL change / variant event).
    try {
      document.addEventListener("variant:change", sync);
      document.addEventListener("variantChange", sync);
      window.addEventListener("popstate", sync);
    } catch (e) { /* ignore */ }

    var sending = false;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (sending) return;
      var email = String(emailEl.value || "").trim();
      if (!EMAIL_RE.test(email) || email.length > 254) { setStatus(statusEl, labels.invalidEmail || ""); return; }
      if (!consentEl.checked) { setStatus(statusEl, labels.needConsent || ""); return; }
      sending = true;
      setStatus(statusEl, labels.sending || "");
      if (submitEl) submitEl.disabled = true;

      var body = JSON.stringify({
        email: email,
        productGid: cfg.productGid,
        variantGid: currentVariantGid(cfg) || undefined,
        locale: cfg.locale || "en",
        consent: true,
        consentTextVersion: cfg.consentTextVersion || "v1",
        source: cfg.source || "product_page"
      });

      var done = false;
      var finish = function (ok) {
        if (done) return; done = true;
        sending = false;
        if (submitEl) submitEl.disabled = false;
        // Generic message either way — never reveals subscription existence.
        setStatus(statusEl, ok ? (labels.success || "") : (labels.error || ""));
      };
      var ctrl = null;
      try { if (typeof AbortController === "function") ctrl = new AbortController(); } catch (e) { ctrl = null; }
      var t = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e) {} finish(false); }, Math.max(1000, Number(cfg.timeoutMs) || 4000));

      try {
        fetch(String(cfg.proxyBase || "/apps/search").replace(/\/+$/, "") + "/back-in-stock", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: body,
          credentials: "omit",
          keepalive: true,
          signal: ctrl ? ctrl.signal : undefined
        }).then(function (r) { clearTimeout(t); finish(r && r.ok); })
          .catch(function () { clearTimeout(t); finish(false); });
      } catch (e) { clearTimeout(t); finish(false); }
    });
  }

  function boot() {
    var nodes = document.querySelectorAll("[data-boost-notify]");
    for (var i = 0; i < nodes.length; i++) {
      var root = nodes[i];
      var cfg = readConfig("boost-notify-config-" + String(root.id).replace(/^boost-notify-/, ""));
      if (cfg) { try { init(root, cfg); } catch (e) { /* silent: never block the page */ } }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
