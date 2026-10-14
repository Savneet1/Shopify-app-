/*
 * boost-analytics.js — Phase 11 storefront analytics emitter. Shared by the
 * results, predictive, recommendations and bundle blocks. Pure logic (event
 * shape, session id) lives in boost-core.js; this file does the DOM send only.
 *
 * Privacy + safety:
 *  - Opt-in per block (the block passes analytics:true only when the merchant
 *    enabled it). No block toggle → window.BoostAnalytics is never configured
 *    for that surface and nothing is sent.
 *  - A session id is attached ONLY in consented_sessions mode AND only when the
 *    Shopify customer-privacy API grants analytics consent
 *    (Core.consentAllowsAnalytics, fail-closed). The consent check happens
 *    BEFORE any sessionStorage access; with no consent nothing is stored and no
 *    session id is sent. A 30-minute inactivity window rotates the id.
 *  - Fire-and-forget: events are queued and flushed via navigator.sendBeacon
 *    (fetch keepalive fallback), batched (<=20), with a hard timeout; a failure
 *    is a silent no-op and NEVER blocks the UI. This emitter does no DOM
 *    rendering at all; no PII is collected client-side (the server re-validates
 *    and redacts).
 */
(function () {
  var Core = (typeof window !== "undefined" && window.BoostSearch) || null;
  if (!Core || typeof document === "undefined") return;

  var SESSION_KEY = "boost_session";
  var SESSION_TS_KEY = "boost_session_ts";
  var SESSION_WINDOW_MS = 30 * 60 * 1000;
  var MAX_BATCH = 20;

  function privacyApi() {
    try { return window.Shopify && window.Shopify.customerPrivacy; } catch (e) { return null; }
  }
  function consentOk() {
    return Core.consentAllowsAnalytics(privacyApi());
  }

  // Consent-gated session id. EVERY sessionStorage access is behind consentOk().
  function sessionId() {
    if (!consentOk()) { clearSession(); return null; }
    try {
      var now = Date.now();
      var id = window.sessionStorage.getItem(SESSION_KEY);
      var ts = Number(window.sessionStorage.getItem(SESSION_TS_KEY) || 0);
      if (!id || !isFinite(ts) || (now - ts) > SESSION_WINDOW_MS) {
        id = Core.newSessionId();
      }
      window.sessionStorage.setItem(SESSION_KEY, id);
      window.sessionStorage.setItem(SESSION_TS_KEY, String(now));
      return id;
    } catch (e) { return null; }
  }
  function clearSession() {
    try { window.sessionStorage.removeItem(SESSION_KEY); window.sessionStorage.removeItem(SESSION_TS_KEY); } catch (e) {}
  }

  var registry = {}; // proxyBase -> { queue: [], timer, flushing }

  function state(proxyBase) {
    var key = String(proxyBase || "/apps/search").replace(/\/+$/, "");
    if (!registry[key]) registry[key] = { base: key, queue: [], timer: null };
    return registry[key];
  }

  function flush(st) {
    if (st.queue.length === 0) return;
    var batch = st.queue.splice(0, MAX_BATCH);
    var sid = sessionId(); // null unless consented
    if (sid) for (var i = 0; i < batch.length; i++) batch[i].sessionId = sid;
    var url = st.base + "/analytics-event";
    var body = JSON.stringify({ events: batch });
    try {
      if (navigator && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } else {
        fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
      }
    } catch (e) { /* silent no-op */ }
  }

  function schedule(st) {
    if (st.timer != null) return;
    try {
      st.timer = window.setTimeout(function () { st.timer = null; flush(st); }, 800);
    } catch (e) { flush(st); }
  }

  // Public API used by the block glue.
  window.BoostAnalytics = {
    /** track(proxyBase, event): queue one event (dropped if invalid / disabled). */
    track: function (proxyBase, event) {
      try {
        var clean = Core.cleanAnalyticsEvent(event);
        if (!clean) return;
        var st = state(proxyBase);
        st.queue.push(clean);
        if (st.queue.length >= MAX_BATCH) flush(st);
        else schedule(st);
      } catch (e) { /* never block the UI */ }
    },
    /** Force flush of all surfaces (called on pagehide). */
    flushAll: function () { for (var k in registry) if (registry.hasOwnProperty(k)) flush(registry[k]); },
  };

  try {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") window.BoostAnalytics.flushAll();
    });
    window.addEventListener("pagehide", function () { window.BoostAnalytics.flushAll(); });
  } catch (e) { /* ok */ }
})();
