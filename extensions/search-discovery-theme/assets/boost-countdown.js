/*
 * Phase 12.5 — countdown timer storefront glue (DISPLAY ONLY).
 *
 * Fetches the applicable countdown from the signed App Proxy, corrects for
 * client/server clock skew using the server-provided `serverNow`, and renders
 * the remaining time with textContent only (never innerHTML). The ticking clock
 * is aria-hidden; a polite status announces only COARSE changes (about once a
 * minute, or more slowly under prefers-reduced-motion) so screen readers are
 * not spammed per second. Shows nothing when no rule applies / the window is not
 * open; after expiry shows the merchant's expired message or nothing. Any
 * failure is a silent no-op.
 */
(function () {
  "use strict";

  function readConfig(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent || "null"); } catch (e) { return null; }
  }

  function prefersReducedMotion() {
    try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }

  // Break a positive millisecond duration into d/h/m/s parts.
  function parts(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return {
      d: Math.floor(s / 86400),
      h: Math.floor((s % 86400) / 3600),
      m: Math.floor((s % 3600) / 60),
      s: s % 60
    };
  }

  function fmtClock(ms, labels) {
    var p = parts(ms);
    var out = [];
    if (p.d > 0) out.push(p.d + (labels.d || "d"));
    out.push(p.h + (labels.h || "h"));
    out.push(p.m + (labels.m || "m"));
    out.push(p.s + (labels.s || "s"));
    return out.join(" ");
  }

  // Coarse SR text: drop the seconds so announcements change ~once a minute.
  function fmtCoarse(ms, labels) {
    var p = parts(ms);
    var out = [labels.endsIn || ""];
    if (p.d > 0) out.push(p.d + (labels.d || "d"));
    out.push(p.h + (labels.h || "h"));
    out.push(p.m + (labels.m || "m"));
    return out.join(" ").trim();
  }

  function render(root, cfg, data) {
    var labelEl = root.querySelector("[data-boost-countdown-label]");
    var clockEl = root.querySelector("[data-boost-countdown-clock]");
    var srEl = root.querySelector("[data-boost-countdown-sr]");
    var labels = cfg.labels || {};

    var endsAt = Date.parse(data.endsAt);
    var serverNow = Date.parse(data.serverNow);
    if (!isFinite(endsAt) || !isFinite(serverNow)) return; // bad payload → nothing
    // offset added to the client clock to approximate the server clock.
    var skew = serverNow - Date.now();

    if (labelEl && data.label) labelEl.textContent = String(data.label);

    function showExpired() {
      if (clockEl) clockEl.textContent = "";
      if (data.expiredMessage) {
        if (labelEl) labelEl.textContent = String(data.expiredMessage);
        if (srEl) srEl.textContent = String(data.expiredMessage);
        root.removeAttribute("hidden");
      } else {
        root.setAttribute("hidden", ""); // nothing after expiry
      }
    }

    var remaining0 = endsAt - (Date.now() + skew);
    if (remaining0 <= 0) { showExpired(); return; }

    root.removeAttribute("hidden");
    var reduced = prefersReducedMotion();
    var tickMs = reduced ? 30000 : 1000;       // bounded interval
    var srEveryMs = 60000;                      // coarse SR cadence
    var lastSr = 0;
    var timer = null;

    function tick() {
      var remaining = endsAt - (Date.now() + skew);
      if (remaining <= 0) { if (timer) clearInterval(timer); showExpired(); return; }
      if (clockEl) clockEl.textContent = fmtClock(remaining, labels);
      var now = Date.now();
      if (srEl && (now - lastSr >= srEveryMs || lastSr === 0)) { srEl.textContent = fmtCoarse(remaining, labels); lastSr = now; }
    }
    tick();
    try { timer = setInterval(tick, tickMs); } catch (e) { /* ignore */ }
  }

  function load(root, cfg) {
    var base = String(cfg.proxyBase || "/apps/search").replace(/\/+$/, "");
    var url = base + "/countdown";
    if (cfg.productRef) url += "?product=" + encodeURIComponent(cfg.productRef);
    var ctrl = null;
    try { if (typeof AbortController === "function") ctrl = new AbortController(); } catch (e) { ctrl = null; }
    var t = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e) {} }, Math.max(500, Number(cfg.timeoutMs) || 2000));
    try {
      fetch(url, { headers: { "Accept": "application/json" }, credentials: "omit", signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { clearTimeout(t); return r && r.ok ? r.json() : null; })
        .then(function (j) { if (j && j.countdown) { try { render(root, cfg, j.countdown); } catch (e) {} } })
        .catch(function () { clearTimeout(t); /* silent no-op */ });
    } catch (e) { clearTimeout(t); /* silent no-op */ }
  }

  function boot() {
    var nodes = document.querySelectorAll("[data-boost-countdown]");
    for (var i = 0; i < nodes.length; i++) {
      var root = nodes[i];
      var cfg = readConfig("boost-countdown-config-" + String(root.id).replace(/^boost-countdown-/, ""));
      if (cfg) { try { load(root, cfg); } catch (e) { /* silent */ } }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
