/*
 * boost-core.js — Phase 7 storefront CORE logic (pure, framework-free, no DOM).
 *
 * UMD: in the browser it defines `window.BoostSearch`; in Node it is
 * `require()`-able so the pure logic is unit-tested without a DOM library.
 * Everything here is deterministic and side-effect free. The DOM glue
 * (boost-predictive.js / boost-results.js) consumes these functions.
 *
 * Mirrors the server bounds (app/lib/search/filters.ts, query.ts) so the
 * storefront never sends values the API would reject, and NEVER trusts URL
 * params: parseState() validates and bounds every field.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module && module.exports) module.exports = api;
  if (root) root.BoostSearch = api; // browser global (and a reliable sink in tests)
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this), function () {
  "use strict";

  // ---- Bounds (mirror the server) ----
  var MAX_QUERY_LEN = 200;
  var MAX_FILTER_VALUES = 50;
  var MAX_FILTER_STR = 100;
  var MAX_COLLECTION_ID = 255;
  var MAX_PRICE = 1000000000;
  var MAX_PAGE = 100000;

  var SORTS = ["relevance", "price_asc", "price_desc", "newest"];
  var IGNORE_KINDS = ["price", "availability", "sort", "vendor", "product_type", "attribute"];
  var MULTI_KEYS = ["vendor", "productType", "tags", "metafield"];

  function clampStr(v, max) {
    if (v == null) return "";
    var s = String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim(); // strip controls (A4 parity)
    return s.length > max ? s.slice(0, max) : s;
  }

  function toMultiList(values) {
    // Accept array or comma string; trim, drop empties, cap count + length.
    var raw = [];
    if (Array.isArray(values)) {
      for (var i = 0; i < values.length; i++) {
        var parts = String(values[i] == null ? "" : values[i]).split(",");
        for (var p = 0; p < parts.length; p++) raw.push(parts[p]);
      }
    } else if (values != null) {
      raw = String(values).split(",");
    }
    var out = [];
    for (var j = 0; j < raw.length && out.length < MAX_FILTER_VALUES; j++) {
      var s = clampStr(raw[j], MAX_FILTER_STR);
      if (s.length > 0) out.push(s);
    }
    return out;
  }

  function toPrice(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    if (!isFinite(n) || n < 0 || n > MAX_PRICE) return null;
    return n;
  }

  function toBool(v) {
    if (v == null || v === "") return null;
    if (v === true || v === "true" || v === "1") return true;
    if (v === false || v === "false" || v === "0") return false;
    return null;
  }

  function toPage(v) {
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n < 1) return 1;
    return n > MAX_PAGE ? MAX_PAGE : n;
  }

  function toSort(v) {
    return SORTS.indexOf(String(v)) >= 0 ? String(v) : "relevance";
  }

  function toIgnore(values) {
    var raw = Array.isArray(values) ? values : [values];
    var flat = [];
    for (var i = 0; i < raw.length; i++) {
      String(raw[i] == null ? "" : raw[i]).split(",").forEach(function (p) { flat.push(p); });
    }
    var out = [];
    for (var j = 0; j < flat.length; j++) {
      var s = flat[j].trim();
      if (IGNORE_KINDS.indexOf(s) >= 0 && out.indexOf(s) < 0) out.push(s);
    }
    return out;
  }

  // getAll(key) -> string[]; get(key) -> string|null. Works with URLSearchParams
  // or a plain {key: value|value[]} map (for tests).
  function makeReader(src) {
    if (src && typeof src.getAll === "function") {
      return {
        getAll: function (k) { return src.getAll(k); },
        get: function (k) { return src.get(k); },
      };
    }
    var map = src || {};
    return {
      getAll: function (k) {
        var v = map[k];
        if (v == null) return [];
        return Array.isArray(v) ? v.map(String) : [String(v)];
      },
      get: function (k) {
        var v = map[k];
        if (v == null) return null;
        return Array.isArray(v) ? (v.length ? String(v[0]) : null) : String(v);
      },
    };
  }

  /**
   * parseState(src): read + VALIDATE + BOUND a state object from URL params
   * (URLSearchParams or a plain map). Never trusts input: unknown sort ->
   * relevance, bad numbers dropped, over-long/over-count values capped, ignore
   * filtered to the known set. Returns a normalized plain object.
   */
  function parseState(src) {
    var r = makeReader(src);
    var nlRaw = r.get("nl");
    return {
      q: clampStr(r.get("q"), MAX_QUERY_LEN),
      vendor: toMultiList(r.getAll("vendor")),
      productType: toMultiList(r.getAll("productType")),
      tags: toMultiList(r.getAll("tags")),
      metafield: toMultiList(r.getAll("metafield")),
      priceMin: toPrice(r.get("priceMin")),
      priceMax: toPrice(r.get("priceMax")),
      available: toBool(r.get("available")),
      collectionId: (function () {
        var c = clampStr(r.get("collectionId"), MAX_COLLECTION_ID);
        return c.length ? c : null;
      })(),
      sort: toSort(r.get("sort")),
      page: toPage(r.get("page")),
      nl: !(nlRaw === "0" || nlRaw === "false"), // on by default
      ignore: toIgnore(r.getAll("ignore")),
    };
  }

  /**
   * serializeState(state): deterministic query string (stable key order, sorted
   * multi-values) so URLs are shareable and back/forward is predictable. Only
   * meaningful (non-default) fields are emitted.
   */
  function serializeState(state) {
    var s = state || {};
    var pairs = [];
    var add = function (k, v) { pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)); };
    if (s.q) add("q", clampStr(s.q, MAX_QUERY_LEN));
    for (var m = 0; m < MULTI_KEYS.length; m++) {
      var key = MULTI_KEYS[m];
      var list = toMultiList(s[key]);
      list.slice().sort().forEach(function (v) { add(key, v); });
    }
    if (toPrice(s.priceMin) != null) add("priceMin", toPrice(s.priceMin));
    if (toPrice(s.priceMax) != null) add("priceMax", toPrice(s.priceMax));
    var av = toBool(s.available);
    if (av != null) add("available", av ? "true" : "false");
    if (s.collectionId) add("collectionId", clampStr(s.collectionId, MAX_COLLECTION_ID));
    if (s.sort && s.sort !== "relevance") add("sort", toSort(s.sort));
    if (s.page && Number(s.page) > 1) add("page", toPage(s.page));
    if (s.nl === false) add("nl", "0");
    toIgnore(s.ignore).slice().sort().forEach(function (k) { add("ignore", k); });
    return pairs.join("&");
  }

  /**
   * buildProxyUrl(base, endpoint, state, perPage): a RELATIVE proxy URL for the
   * App Proxy (products|predictive|suggest). `base` is "/{prefix}/{subpath}"
   * (default "/apps/search"). Converts page -> offset/limit for products.
   */
  function buildProxyUrl(base, endpoint, state, perPage) {
    var b = String(base || "/apps/search").replace(/\/+$/, "");
    var qs = serializeState(state);
    var extra = [];
    if (endpoint === "products") {
      var limit = Math.max(1, Math.min(60, Math.floor(Number(perPage) || 24)));
      var page = toPage(state && state.page);
      extra.push("limit=" + limit);
      extra.push("offset=" + (page - 1) * limit);
    }
    // page is encoded as offset for the API; drop the raw page param.
    qs = qs.split("&").filter(function (p) { return p && p.indexOf("page=") !== 0; }).join("&");
    var all = [qs].concat(extra).filter(Boolean).join("&");
    return b + "/" + endpoint + (all ? "?" + all : "");
  }

  function normHost(h) {
    if (h == null) return "";
    return String(h).toLowerCase().replace(/\.$/, "").trim();
  }

  // A root-relative path that is safe to use as-is (shared by path + image
  // checks). Rejects protocol-relative, backslash, raw + encoded control chars
  // and "/scheme:" tricks.
  function safeRelative(u) {
    if (u.charAt(0) !== "/") return false;
    if (u.charAt(1) === "/") return false;   // //host
    if (u.charAt(1) === "\\") return false;   // /\host
    if (/[\u0000-\u001f]/.test(u)) return false;
    if (/%0[9ad]/i.test(u)) return false;     // encoded TAB/LF/CR
    if (/^\/[a-z][a-z0-9+.-]*:/i.test(u)) return false; // "/javascript:"
    return true;
  }

  function parseUrl(u) {
    try {
      if (typeof URL === "function") return new URL(u);
    } catch (e) { return null; }
    return null;
  }

  /**
   * toSameSitePath(url, allowedHosts, currentHost): FAIL-CLOSED allowlist
   * validation that returns a root-relative path to navigate to, or null.
   *
   * The real API returns ABSOLUTE urls (Shopify onlineStoreUrl, e.g.
   * https://shop.myshopify.com/products/x or https://www.store.com/products/x).
   * A root-relative path passes through. An absolute http(s) URL is accepted
   * ONLY when its hostname (lower-cased, trailing dot stripped) is in
   * `allowedHosts` or equals `currentHost`; it then returns pathname+search+hash
   * so navigation stays on the visitor's current origin. Everything else — other
   * schemes, protocol-relative, userinfo, look-alike/added-label hosts, encoded
   * control chars, malformed URLs — returns null. Port is IGNORED in host
   * matching (navigation uses only the path, so a port cannot send the visitor
   * off-site).
   */
  function toSameSitePath(url, allowedHosts, currentHost) {
    if (url == null) return null;
    var u = String(url).trim();
    if (u.length === 0) return null;
    if (u.charAt(0) === "/") return safeRelative(u) ? u : null; // relative
    var parsed = parseUrl(u);
    if (!parsed) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null; // userinfo (a@b trick)
    if (parsed.hostname.indexOf("%") >= 0) return null;  // encoded host chars
    if (/[\u0000-\u001f]/.test(u) || /%0[9ad]/i.test(u.split("/").slice(0, 3).join("/"))) return null;
    var host = normHost(parsed.hostname);
    var allow = (allowedHosts || []).map(normHost);
    var cur = normHost(currentHost);
    if (allow.indexOf(host) < 0 && !(cur && host === cur)) return null;
    // G1 (7.1b): the parsed pathname can still be protocol-relative —
    // e.g. "https://allowed.com//evil.com/x" -> "//evil.com/x", and the URL
    // parser turns a backslash into a slash ("...\evil.com" -> "//evil.com").
    // Re-validate the built path with the SAME relative check; reject (fall
    // back to the native link) rather than "repair" it. Real Shopify product
    // paths never start with "//".
    var path = (parsed.pathname || "/") + (parsed.search || "") + (parsed.hash || "");
    return safeRelative(path) ? path : null;
  }

  /**
   * isSafeImageUrl(url, allowedImageHosts): boolean. An image src — NEVER used
   * for navigation. A root-relative path passes. An absolute URL must be https
   * (not http) and its hostname must be in `allowedImageHosts` (e.g.
   * cdn.shopify.com plus the shop's own domains). Returns the as-is URL's
   * safety; the caller uses the original URL when true.
   */
  function isSafeImageUrl(url, allowedImageHosts) {
    if (url == null) return false;
    var u = String(url).trim();
    if (u.length === 0) return false;
    if (u.charAt(0) === "/") return safeRelative(u);
    var parsed = parseUrl(u);
    if (!parsed) return false;
    if (parsed.protocol !== "https:") return false; // images: https only
    if (parsed.username || parsed.password) return false;
    if (parsed.hostname.indexOf("%") >= 0) return false;
    var host = normHost(parsed.hostname);
    return (allowedImageHosts || []).map(normHost).indexOf(host) >= 0;
  }

  /**
   * formatPrice(min, max, currency, locale): a display price string. Uses
   * Intl.NumberFormat (style currency) when a currency is given, inside
   * try/catch with a plain-number fallback (invalid currency code / no Intl).
   * Range when max differs from min; single value otherwise; "" when there is
   * no price. (Markets / multi-currency conversion is Phase 13 — this only
   * formats the shop's own currency.)
   */
  function formatPrice(min, max, currency, locale) {
    var lo = (min == null || min === "") ? null : Number(min);
    var hi = (max == null || max === "") ? null : Number(max);
    if (lo == null || !isFinite(lo)) return "";
    var fmt = function (n) {
      if (currency) {
        try {
          return new Intl.NumberFormat(locale || undefined, { style: "currency", currency: currency }).format(n);
        } catch (e) { /* invalid code / no Intl → fall through */ }
      }
      return String(n);
    };
    if (hi != null && isFinite(hi) && hi !== lo) return fmt(lo) + "–" + fmt(hi);
    return fmt(lo);
  }

  /**
   * consentAllowsAnalytics(privacyApi): FAIL-CLOSED consent gate for the
   * anonymous A/B token. Returns true ONLY when the Shopify customer-privacy API
   * object exists and a documented "analytics processing allowed" check returns
   * STRICTLY true. An absent API, missing method, thrown error, or any non-true
   * result (undefined, "true" string, etc.) → false. (The exact API method
   * names/behaviour are Requires Verification on a real store; failing closed
   * means a wrong guess only ever produces control, never tracking.)
   */
  function consentAllowsAnalytics(privacyApi) {
    try {
      if (!privacyApi || typeof privacyApi !== "object") return false;
      if (typeof privacyApi.analyticsProcessingAllowed === "function") {
        return privacyApi.analyticsProcessingAllowed() === true;
      }
      if (typeof privacyApi.userCanBeTracked === "function") {
        return privacyApi.userCanBeTracked() === true;
      }
      return false;
    } catch (e) { return false; }
  }

  /**
   * sanitizeToken(raw): bound the anonymous A/B token. Returns the token only
   * when it is 1..64 chars of [A-Za-z0-9_-]; otherwise null (treated as absent →
   * control). Mirrors the server-side guard.
   */
  function sanitizeToken(raw) {
    if (raw == null) return null;
    var s = String(raw);
    if (s.length < 1 || s.length > 64) return null;
    return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
  }

  /**
   * decideFallback({timedOut, httpError, body}): the single rule for when the
   * enhancement must defer to the theme's native search. True on timeout, on a
   * non-OK HTTP status, on a missing/invalid body, or when the API itself asks
   * for native fallback ({fallback:"native"}).
   */
  function decideFallback(ctx) {
    var c = ctx || {};
    if (c.timedOut) return true;
    if (c.httpError) return true;
    if (!c.body || typeof c.body !== "object") return true;
    if (c.body.fallback === "native") return true;
    return false;
  }

  /**
   * comboboxKey(state, key, count): ARIA combobox keyboard state machine for the
   * predictive dropdown. `state` = {open, index}. Returns the next
   * {open, index, action} where action ∈ none|move|select|close|submit.
   * index is -1 when nothing is active. Up/Down wrap; Escape closes; Enter
   * selects the active option or submits when none is active.
   */
  function comboboxKey(state, key, count) {
    var open = !!(state && state.open);
    var idx = state && typeof state.index === "number" ? state.index : -1;
    var n = Math.max(0, Number(count) || 0);
    if (key === "ArrowDown") {
      if (!open || n === 0) return { open: open, index: -1, action: "none" };
      var d = idx + 1 >= n ? 0 : idx + 1;
      return { open: true, index: d, action: "move" };
    }
    if (key === "ArrowUp") {
      if (!open || n === 0) return { open: open, index: -1, action: "none" };
      var u = idx - 1 < 0 ? n - 1 : idx - 1;
      return { open: true, index: u, action: "move" };
    }
    if (key === "Home") {
      if (!open || n === 0) return { open: open, index: idx, action: "none" };
      return { open: true, index: 0, action: "move" };
    }
    if (key === "End") {
      if (!open || n === 0) return { open: open, index: idx, action: "none" };
      return { open: true, index: n - 1, action: "move" };
    }
    if (key === "Escape") {
      return { open: false, index: -1, action: "close" };
    }
    if (key === "Enter") {
      if (open && idx >= 0 && idx < n) return { open: false, index: idx, action: "select" };
      return { open: false, index: -1, action: "submit" };
    }
    return { open: open, index: idx, action: "none" };
  }

  // ---- Phase 9: recently-viewed product refs (pure; storage/consent is glue) ----
  var MAX_RECENT = 12;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var GID_RE = /^gid:\/\/shopify\/Product\/[0-9]{1,20}$/;
  var HANDLE_RE = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;

  /**
   * normalizeRef(raw): a valid product ref (uuid / Product gid / handle) or
   * null. Handles are lower-cased. Mirrors the server (app/lib/recommend/refs.ts)
   * so the storefront never stores or sends a ref the API would reject.
   */
  function normalizeRef(raw) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (s.length === 0 || s.length > 255) return null;
    if (UUID_RE.test(s)) return s;
    if (GID_RE.test(s)) return s;
    var lower = s.toLowerCase();
    return HANDLE_RE.test(lower) ? lower : null;
  }

  /**
   * parseRecentIds(raw, max): validate + dedupe + cap a comma string or array of
   * refs (first occurrence wins, order preserved). Never throws.
   */
  function parseRecentIds(raw, max) {
    var cap = max == null ? MAX_RECENT : max;
    var parts = Array.isArray(raw) ? raw : (raw == null ? [] : String(raw).split(","));
    var out = [];
    var seen = {};
    for (var i = 0; i < parts.length && out.length < cap; i++) {
      var ref = normalizeRef(parts[i]);
      if (ref && !seen[ref]) { seen[ref] = true; out.push(ref); }
    }
    return out;
  }

  /**
   * pushRecentId(list, id, max): return a new most-recent-first list with `id`
   * moved/added to the front, deduped and capped. An invalid id leaves the list
   * unchanged (validated + bounded first).
   */
  function pushRecentId(list, id, max) {
    var cap = max == null ? MAX_RECENT : max;
    var ref = normalizeRef(id);
    var existing = parseRecentIds(list, cap);
    if (!ref) return existing;
    var out = [ref];
    for (var i = 0; i < existing.length && out.length < cap; i++) {
      if (existing[i] !== ref) out.push(existing[i]);
    }
    return out;
  }

  /** Serialize a recent-ids list to the bounded `recent` query param value. */
  function serializeRecentIds(list, max) {
    return parseRecentIds(list, max).join(",");
  }

  // ---- Phase 10: Ajax cart add URL (pure) ----
  /**
   * cartAddUrl(root): build the theme's Ajax cart-add endpoint from
   * window.Shopify.routes.root (e.g. "/" or "/en-gb/"). A missing/odd root falls
   * back to "/". Markets/locale prefixes beyond what `root` carries are Phase 13
   * (Requires Verification). Only ever returns a root-relative path.
   */
  function cartAddUrl(root) {
    var r = (root == null || String(root).charAt(0) !== "/") ? "/" : String(root);
    if (r.charAt(r.length - 1) !== "/") r += "/";
    // guard against control chars / protocol-relative tricks sneaking through
    if (r.charAt(1) === "/" || /[\u0000-\u001f]/.test(r)) r = "/";
    return r + "cart/add.js";
  }

  /**
   * isNumericId(v): a bare positive integer id SAFE to pass to the cart as a
   * JS number. Rejects anything that is not a positive safe integer — e.g. a
   * 19-digit id that Number() would round to a different variant (M4a).
   */
  function isNumericId(v) {
    if (typeof v === "number") return isFinite(v) && v > 0 && Number.isSafeInteger(v);
    if (typeof v !== "string") return false;
    if (!/^[0-9]{1,19}$/.test(v)) return false;
    var n = Number(v);
    return Number.isSafeInteger(n) && n > 0;
  }

  // ---- Phase 11: analytics event shape + session helpers (pure) ----
  var ANALYTICS_EVENT_TYPES = {
    search_performed: 1, search_zero_result: 1, result_click: 1, predictive_click: 1,
    suggestion_click: 1, redirect_followed: 1, add_to_cart_from_search: 1,
    recommendation_click: 1, bundle_add_to_cart: 1, filter_applied: 1,
  };
  var ANALYTICS_SURFACES = { search_page: 1, predictive: 1, recommendation: 1, bundle: 1, redirect: 1 };

  /** A new random session id: 24 chars of [A-Za-z0-9_-] (<=64, matches server). */
  function newSessionId() {
    var s = (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))
      .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
    return s.length >= 8 ? s : ("s" + s + "00000000").slice(0, 16);
  }

  /** Validate a client analytics event shape before it is queued/sent. Returns
   * a trimmed event or null. Pure — mirrors the server's allow-list. */
  function cleanAnalyticsEvent(ev) {
    if (!ev || typeof ev !== "object") return null;
    if (!ANALYTICS_EVENT_TYPES[ev.eventType]) return null;
    if (!ANALYTICS_SURFACES[ev.surface]) return null;
    var out = { eventType: ev.eventType, surface: ev.surface };
    if (ev.query != null) out.query = String(ev.query).slice(0, 200);
    if (ev.productGid != null && /^gid:\/\/shopify\/Product\/[0-9]{1,20}$/.test(String(ev.productGid))) out.productGid = String(ev.productGid);
    if (ev.resultCount != null && isFinite(Number(ev.resultCount))) out.resultCount = Math.max(0, Math.floor(Number(ev.resultCount)));
    if (ev.position != null && isFinite(Number(ev.position))) out.position = Math.max(0, Math.floor(Number(ev.position)));
    if (ev.experimentId != null) out.experimentId = String(ev.experimentId);
    if (ev.variant === "A" || ev.variant === "B" || ev.variant === "control") out.variant = ev.variant;
    return out;
  }

  /** Simple per-reader-independent debounce helper (used by the glue; pure). */
  function makeDebouncer(setTimeoutFn, clearTimeoutFn) {
    var st = setTimeoutFn || (typeof setTimeout !== "undefined" ? setTimeout : null);
    var ct = clearTimeoutFn || (typeof clearTimeout !== "undefined" ? clearTimeout : null);
    var h = null;
    return function (fn, ms) {
      if (h != null && ct) ct(h);
      if (st) h = st(fn, ms);
    };
  }

  // ---- Phase 13.1: client-side PII guard (port of server Phase 11.1) ----
  // Canonicalise-then-redact so a split/obfuscated email or digit run is still
  // caught before anything is written to the shopper's own browser storage. We
  // NEVER store a search that looks like PII. Pure, never throws.
  var PII_EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
  var PII_URL_RE = /\b(?:https?:\/\/|www\.)\S+/giu;
  var PII_CARD_RE = /(?:\p{Nd}[ -]?){13,19}/gu;
  var PII_PHONE_RE = /\+?\p{Nd}[\p{Nd} ().-]{5,}\p{Nd}/gu;
  var PII_TOKEN_RE = /\b[A-Za-z0-9_-]{20,}\b/g;
  var PII_INVISIBLE_RE = /[­​-‏⁠﻿]/g;
  var PII_Nd_RE = /\p{Nd}/u;
  var PII_DIGIT_ZEROES = [
    0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66,
    0xce6, 0xd66, 0xe50, 0xed0, 0xf20, 0x1040, 0x17e0, 0x1810, 0xff10,
  ];
  function piiFoldDigit(ch) {
    var cp = ch.codePointAt(0);
    for (var i = 0; i < PII_DIGIT_ZEROES.length; i++) {
      var z = PII_DIGIT_ZEROES[i];
      if (cp >= z && cp <= z + 9) return String(cp - z);
    }
    return ch;
  }
  function piiCountDigits(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (PII_Nd_RE.test(s[i])) n++;
    return n;
  }
  function canonicalizeForPII(input) {
    try {
      var s = String(input).normalize("NFKC").replace(PII_INVISIBLE_RE, "").replace(/\p{Cf}/gu, "");
      if (PII_Nd_RE.test(s)) s = s.replace(/\p{Nd}/gu, piiFoldDigit);
      return s;
    } catch (e) { return String(input == null ? "" : input); }
  }
  function redactPII(input) {
    var redacted = false;
    var out = String(input == null ? "" : input);
    var apply = function (re, test) {
      out = out.replace(re, function (m) {
        if (test && !test(m)) return m;
        redacted = true;
        return "[redacted]";
      });
    };
    try {
      apply(PII_EMAIL_RE);
      apply(PII_URL_RE);
      apply(PII_CARD_RE, function (m) { var d = piiCountDigits(m); return d >= 13 && d <= 19; });
      apply(PII_PHONE_RE, function (m) { return piiCountDigits(m) >= 7; });
      apply(PII_TOKEN_RE);
    } catch (e) { /* a Unicode-property engine gap must never throw */ }
    return { text: out, redacted: redacted };
  }
  /** True when `raw` looks like PII (canonicalised first, so obfuscation is
   * caught). Interest storage refuses any search for which this is true. */
  function isLikelyPII(raw) {
    return redactPII(canonicalizeForPII(raw)).redacted;
  }

  // ---- Phase 13.1: interest-based suggestions (CLIENT-ONLY, consent-gated) ----
  // ONE localStorage key, versioned JSON, 90-day TTL, ~4KB cap. The server
  // stores and logs NOTHING. Every read/write goes through the guarded helpers
  // below, which require consentAllowsAnalytics(...) === true (fail-closed) and
  // DELETE the entry whenever consent is absent. The pure helpers are testable
  // without a DOM; the storage glue is the ONLY place that touches localStorage
  // for this key.
  var INTEREST_KEY = "boost_interest_v1";
  var INTEREST_VERSION = 1;
  var INTEREST_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  var INTEREST_HALFLIFE_MS = 30 * 24 * 60 * 60 * 1000;
  var INTEREST_MAX_RECENT = 10;
  var INTEREST_RECENT_MAXLEN = 60;
  var INTEREST_MAX_KEYS = 20;
  var INTEREST_MAX_BYTES = 4096;

  function interestEmpty(now) {
    return { v: INTEREST_VERSION, ts: now || 0, enabled: true, recent: [], weights: {}, decayedAt: now || 0 };
  }
  /** Validate + bound a parsed interest object (defensive against tampering). */
  function interestCanonical(parsed, now) {
    if (!parsed || typeof parsed !== "object" || parsed.v !== INTEREST_VERSION) return interestEmpty(now);
    var st = interestEmpty(now);
    st.ts = typeof parsed.ts === "number" && isFinite(parsed.ts) ? parsed.ts : (now || 0);
    st.enabled = parsed.enabled !== false;
    st.decayedAt = typeof parsed.decayedAt === "number" && isFinite(parsed.decayedAt) ? parsed.decayedAt : st.ts;
    if (Array.isArray(parsed.recent)) {
      var seen = {};
      for (var i = 0; i < parsed.recent.length && st.recent.length < INTEREST_MAX_RECENT; i++) {
        var q = parsed.recent[i];
        if (typeof q !== "string") continue;
        q = q.slice(0, INTEREST_RECENT_MAXLEN);
        var k = q.toLowerCase();
        if (q.length === 0 || seen[k]) continue;
        seen[k] = true;
        st.recent.push(q);
      }
    }
    if (parsed.weights && typeof parsed.weights === "object") {
      var keys = Object.keys(parsed.weights);
      for (var j = 0; j < keys.length; j++) {
        var kk = keys[j];
        var val = Math.floor(Number(parsed.weights[kk]));
        if (typeof kk === "string" && kk.length > 0 && kk.length <= 80 && isFinite(val) && val > 0) {
          st.weights[kk] = val;
        }
      }
      st.weights = interestEvict(st.weights);
    }
    return st;
  }
  /** Keep at most INTEREST_MAX_KEYS weights, evicting the lowest (ties: by key
   * name, deterministic). Returns a new object. */
  function interestEvict(weights) {
    var keys = Object.keys(weights);
    if (keys.length <= INTEREST_MAX_KEYS) return weights;
    keys.sort(function (a, b) { return (weights[b] - weights[a]) || (a < b ? -1 : a > b ? 1 : 0); });
    var out = {};
    for (var i = 0; i < INTEREST_MAX_KEYS; i++) out[keys[i]] = weights[keys[i]];
    return out;
  }
  /** Halve every weight once per elapsed 30-day half-life; drop zeros. Pure. */
  function interestDecay(state, now) {
    var st = interestCanonical(state, now);
    var elapsed = now - st.decayedAt; // decayedAt is always a number (0 = epoch)
    if (!(elapsed >= INTEREST_HALFLIFE_MS)) return st;
    var halvings = Math.floor(elapsed / INTEREST_HALFLIFE_MS);
    var factor = Math.pow(2, halvings);
    var next = {};
    var keys = Object.keys(st.weights);
    for (var i = 0; i < keys.length; i++) {
      var v = Math.floor(st.weights[keys[i]] / factor);
      if (v > 0) next[keys[i]] = v;
    }
    st.weights = next;
    st.decayedAt = st.decayedAt + halvings * INTEREST_HALFLIFE_MS;
    return st;
  }
  /** Add a recent search (dedup ci, cap 10, len 60). Returns a NEW state, or the
   * input unchanged when the query is empty or looks like PII. Pure. */
  function interestAddSearch(state, query, now) {
    var st = interestCanonical(state, now);
    var q = (query == null ? "" : String(query)).trim();
    if (q.length === 0) return st;
    if (q.length > INTEREST_RECENT_MAXLEN) q = q.slice(0, INTEREST_RECENT_MAXLEN);
    if (isLikelyPII(q)) return st; // never store PII searches
    var lk = q.toLowerCase();
    var out = [q];
    for (var i = 0; i < st.recent.length && out.length < INTEREST_MAX_RECENT; i++) {
      if (st.recent[i].toLowerCase() !== lk) out.push(st.recent[i]);
    }
    st.recent = out;
    st.ts = now;
    return st;
  }
  /** Bump interest weights from a CLICKED product's facets (productType, vendor,
   * tags). Integer counters; keys namespaced so "type:Shoe" ≠ "vendor:Shoe".
   * Caps at 20 keys (evict lowest). Returns a NEW state. Pure. */
  function interestAddClick(state, product, now) {
    var st = interestCanonical(state, now);
    if (!product || typeof product !== "object") return st;
    var bump = function (prefix, raw) {
      if (raw == null) return;
      var s = String(raw).trim().slice(0, 72);
      if (s.length === 0) return;
      var key = prefix + ":" + s;
      st.weights[key] = (st.weights[key] || 0) + 1;
    };
    bump("type", product.productType);
    bump("vendor", product.vendor);
    var tags = product.tags;
    if (Array.isArray(tags)) for (var i = 0; i < tags.length && i < 10; i++) bump("tag", tags[i]);
    st.weights = interestEvict(st.weights);
    st.ts = now;
    return st;
  }
  /** Deterministic, STABLE re-order of suggestion items by interest weight.
   * NEVER adds or removes an item — only re-orders. `scoreOf(item)` returns the
   * item's weight contribution (sum of its facet weights). Pure. */
  function interestReorder(items, scoreOf) {
    var arr = Array.isArray(items) ? items.slice() : [];
    var score = typeof scoreOf === "function" ? scoreOf : function () { return 0; };
    // Phase 13b C5: a scorer must NEVER break rendering. A throwing scorer, or a
    // NaN/Infinity/string/null result, scores 0 so that item keeps its original
    // position; the whole thing never throws, never adds/removes an item.
    var decorated = arr.map(function (it, i) {
      var s = 0;
      try { s = Number(score(it)); } catch (e) { s = 0; }
      if (!isFinite(s)) s = 0;
      return { it: it, i: i, s: s };
    });
    decorated.sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); }); // stable: original index breaks ties
    return decorated.map(function (d) { return d.it; });
  }

  // Storage glue — the ONLY code that touches the interest localStorage key.
  function interestRead(privacyApi, now, storage) {
    var ls = storage || (typeof window !== "undefined" ? window.localStorage : null);
    var t = typeof now === "number" ? now : Date.now();
    if (!consentAllowsAnalytics(privacyApi)) {
      try { if (ls) ls.removeItem(INTEREST_KEY); } catch (e) {}
      return interestEmpty(t);
    }
    try {
      if (!ls) return interestEmpty(t);
      var raw = ls.getItem(INTEREST_KEY);
      if (!raw) return interestEmpty(t);
      var parsed = JSON.parse(raw);
      var st = interestCanonical(parsed, t);
      if ((t - st.ts) > INTEREST_TTL_MS) { // expired → wipe (ts is a number)
        try { ls.removeItem(INTEREST_KEY); } catch (e2) {}
        return interestEmpty(t);
      }
      return interestDecay(st, t);
    } catch (e) { return interestEmpty(t); }
  }
  function interestWrite(privacyApi, state, storage) {
    var ls = storage || (typeof window !== "undefined" ? window.localStorage : null);
    if (!consentAllowsAnalytics(privacyApi)) {
      try { if (ls) ls.removeItem(INTEREST_KEY); } catch (e) {}
      return false;
    }
    try {
      if (!ls) return false;
      var st = interestCanonical(state, state && state.ts);
      var json = JSON.stringify(st);
      // Bound the stored size: trim recent then weights until under the cap.
      while (json.length > INTEREST_MAX_BYTES && st.recent.length > 0) {
        st.recent.pop(); json = JSON.stringify(st);
      }
      while (json.length > INTEREST_MAX_BYTES && Object.keys(st.weights).length > 0) {
        var ks = Object.keys(st.weights);
        ks.sort(function (a, b) { return (st.weights[a] - st.weights[b]) || (a < b ? -1 : 1); });
        delete st.weights[ks[0]]; json = JSON.stringify(st);
      }
      if (json.length > INTEREST_MAX_BYTES) return false;
      ls.setItem(INTEREST_KEY, json);
      return true;
    } catch (e) { return false; }
  }
  function interestClear(storage) {
    var ls = storage || (typeof window !== "undefined" ? window.localStorage : null);
    try { if (ls) ls.removeItem(INTEREST_KEY); } catch (e) {}
  }

  // ---- Phase 13.2: locale resolver + Intl plural/date (pure) ----
  // Mirrors app/lib/i18n/locales.ts. The app sets lang/dir on ITS OWN root only
  // (never <html>) so the extension can be RTL on an LTR theme.
  var SUPPORTED_LOCALES = [
    { code: "en", dir: "ltr" }, { code: "fr", dir: "ltr" }, { code: "de", dir: "ltr" },
    { code: "es", dir: "ltr" }, { code: "it", dir: "ltr" }, { code: "pt-BR", dir: "ltr" },
    { code: "nl", dir: "ltr" }, { code: "ja", dir: "ltr" }, { code: "ar", dir: "rtl" },
  ];
  function baseLanguage(code) { return String(code).split("-")[0].toLowerCase(); }
  function resolveLocale(requested, supported, fallback) {
    var list = supported || SUPPORTED_LOCALES;
    var fb = fallback || "en";
    if (typeof requested !== "string") return fb;
    var req = requested.trim();
    if (req.length === 0 || req.length > 35) return fb;
    var lower = req.toLowerCase();
    for (var i = 0; i < list.length; i++) if (list[i].code.toLowerCase() === lower) return list[i].code;
    var base = baseLanguage(req);
    for (var j = 0; j < list.length; j++) if (baseLanguage(list[j].code) === base) return list[j].code;
    return fb;
  }
  function localeDir(code) {
    for (var i = 0; i < SUPPORTED_LOCALES.length; i++) if (SUPPORTED_LOCALES[i].code === code) return SUPPORTED_LOCALES[i].dir;
    return "ltr";
  }
  /** Set lang + dir on the APP's OWN root element only. Never touches <html>. */
  function applyLocaleToRoot(rootEl, code) {
    if (!rootEl || !rootEl.setAttribute) return;
    try { rootEl.setAttribute("lang", code); rootEl.setAttribute("dir", localeDir(code)); } catch (e) {}
  }
  /** CLDR plural category for n in locale (Intl.PluralRules), default "other". */
  function pluralCategory(locale, n) {
    try { return new Intl.PluralRules(locale || undefined).select(Number(n)); }
    catch (e) { return Number(n) === 1 ? "one" : "other"; }
  }
  /** Format a count with pluralised forms, NO string concatenation of the noun:
   * `forms` maps CLDR categories ({one, other, zero?, two?, few?, many?}) to a
   * template containing {count}. {count} is replaced by Intl.NumberFormat. */
  function formatCount(n, locale, forms) {
    var num = Number(n) || 0;
    var cat = pluralCategory(locale, num);
    var tmpl = (forms && (forms[cat] || forms.other)) || "{count}";
    var numStr;
    try { numStr = new Intl.NumberFormat(locale || undefined).format(num); } catch (e) { numStr = String(num); }
    return tmpl.replace(/\{count\}/g, numStr);
  }
  /** Format a date in the visitor's locale + an explicit IANA time zone (shop tz
   * for pre-order ship dates / countdown ends). Returns "" on any failure. */
  function formatDateInTz(date, locale, timeZone, opts) {
    try {
      var d = (date instanceof Date) ? date : new Date(date);
      if (isNaN(d.getTime())) return "";
      var o = opts || { year: "numeric", month: "short", day: "numeric" };
      if (timeZone) o = Object.assign({ timeZone: timeZone }, o);
      return new Intl.DateTimeFormat(locale || undefined, o).format(d);
    } catch (e) { return ""; }
  }

  // ---- Phase 13.3: client price hydration (same-origin /products/<handle>.js)
  // READ-ONLY, no scope, no server change. Parse defensively (integers in minor
  // units), reformat via Intl in the storefront's active currency. This is a
  // DISPLAY reformat of shop-currency amounts — true presentment conversion is
  // Requires Verification on a real market-enabled store. Falls back SILENTLY to
  // the indexed price (never a mislabelled number).
  var HYDRATE_MAX_CARDS = 12;
  var HYDRATE_CONCURRENCY = 4;
  var HYDRATE_TIMEOUT_MS = 1500;
  // An absurd minor-unit amount is treated as invalid (a probe rendered 1e30 as
  // "$10,000,000,000,000,000,000,000,000,000.00"). 1e11 minor units = 1e9 major
  // in a 2-digit currency — far above any real product price.
  var HYDRATE_MAX_MINOR = 1e11;

  /** minor-unit exponent for a currency (via Intl), default 2; JPY→0 etc. */
  function currencyFractionDigits(currency) {
    try {
      var f = new Intl.NumberFormat(undefined, { style: "currency", currency: currency });
      var d = f.resolvedOptions().maximumFractionDigits;
      return typeof d === "number" ? d : 2;
    } catch (e) { return 2; }
  }
  /** True only for currencies whose ISO fraction digits are 2. Phase 13b C3:
   * until the Ajax-API money normalisation is verified on a real store, we only
   * HYDRATE 2-digit currencies; others silently keep the indexed price. */
  function currencyHydrationEligible(currency) {
    // Phase 14.6b: a missing/invalid currency is NOT eligible — otherwise a bare
    // number (no currency symbol) could be shown. Require a 3-letter ISO code.
    if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return false;
    return currencyFractionDigits(currency) === 2;
  }
  /**
   * Format an Ajax /products/<handle>.js money value as currency. Phase 13b C3:
   * the Shopify Ajax API normalises ALL money values to HUNDREDTHS even for
   * zero-decimal currencies (JPY, KRW) — a Shopify-staff community reply, NOT
   * official docs (Requires Verification). So we divide by 100 and let Intl round
   * to the active currency's own digits (JPY 1290000 -> ¥12,900; USD 12900 ->
   * $129.00). Absurd / non-finite / negative values → "" (keep indexed price).
   */
  function formatMoneyMinor(amountMinor, currency, locale) {
    if (typeof amountMinor !== "number" || !isFinite(amountMinor) || amountMinor < 0 || amountMinor > HYDRATE_MAX_MINOR) return "";
    var major = amountMinor / 100; // Ajax hundredths, regardless of the currency's own digits
    try {
      if (currency) return new Intl.NumberFormat(locale || undefined, { style: "currency", currency: currency }).format(major);
    } catch (e) {}
    return String(major);
  }
  /** Parse a Shopify product.js object → {minMinor, maxMinor} integer minor
   * units, or null. Defensive: ignores non-integer/negative/absurd values. */
  function parseProductJsPrices(obj) {
    if (!obj || typeof obj !== "object") return null;
    var isMinor = function (n) {
      return typeof n === "number" && isFinite(n) && n >= 0 && n <= HYDRATE_MAX_MINOR && Math.floor(n) === n;
    };
    var lo = null, hi = null;
    if (isMinor(obj.price_min) && isMinor(obj.price_max)) { lo = obj.price_min; hi = obj.price_max; }
    else if (Array.isArray(obj.variants)) {
      for (var i = 0; i < obj.variants.length; i++) {
        var p = obj.variants[i] && obj.variants[i].price;
        if (isMinor(p)) { lo = (lo == null || p < lo) ? p : lo; hi = (hi == null || p > hi) ? p : hi; }
      }
    } else if (isMinor(obj.price)) { lo = hi = obj.price; }
    if (lo == null) return null;
    return { minMinor: lo, maxMinor: hi == null ? lo : hi };
  }
  /** Full card price string from a parsed product.js, or null to keep the
   * indexed fallback. Phase 13b C3: non-2-digit currencies are NOT hydrated
   * (silent fallback) until the Ajax normalisation is verified. */
  function hydratedPriceString(obj, currency, locale) {
    if (!currencyHydrationEligible(currency)) return null; // silent fallback
    var p = parseProductJsPrices(obj);
    if (!p) return null;
    var lo = formatMoneyMinor(p.minMinor, currency, locale);
    if (!lo) return null;
    if (p.maxMinor !== p.minMinor) {
      var hi = formatMoneyMinor(p.maxMinor, currency, locale);
      if (hi) return lo + "–" + hi;
    }
    return lo;
  }

  /**
   * Bounded-concurrency hydration orchestrator (pure glue; fetchJs + state
   * injected so it is unit-testable without a DOM/network). `handles` is capped
   * at 12. `fetchJs(handle)` returns a Promise of the parsed product.js (or
   * rejects/null on any failure). Per-handle timeout (race against a timer).
   * `cache` is a Map shared across calls (session cache). `aborted()` returns
   * true to stop (navigation). `onResult(handle, obj|null)` is called per handle
   * (null = silent fallback). Resolves when all done. Never throws.
   */
  function runHydration(handles, fetchJs, opts, onResult) {
    opts = opts || {};
    var list = (Array.isArray(handles) ? handles : []).slice(0, HYDRATE_MAX_CARDS);
    var concurrency = opts.concurrency || HYDRATE_CONCURRENCY;
    var timeoutMs = opts.timeoutMs || HYDRATE_TIMEOUT_MS;
    var cache = opts.cache || new Map();
    var aborted = typeof opts.aborted === "function" ? opts.aborted : function () { return false; };
    var setTimeoutFn = opts.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);
    var clearTimeoutFn = opts.clearTimeout || (typeof clearTimeout !== "undefined" ? clearTimeout : null);
    var emit = typeof onResult === "function" ? onResult : function () {};
    var idx = 0;

    function withTimeout(promise) {
      if (!setTimeoutFn) return Promise.resolve(promise);
      return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeoutFn(function () { if (!done) { done = true; resolve(null); } }, timeoutMs);
        Promise.resolve(promise).then(function (v) {
          if (!done) { done = true; if (clearTimeoutFn) clearTimeoutFn(timer); resolve(v); }
        }, function () {
          if (!done) { done = true; if (clearTimeoutFn) clearTimeoutFn(timer); resolve(null); }
        });
      });
    }
    function one(handle) {
      if (aborted()) { emit(handle, null); return Promise.resolve(); }
      if (cache.has(handle)) { emit(handle, cache.get(handle)); return Promise.resolve(); }
      var p;
      try { p = fetchJs(handle); } catch (e) { p = Promise.resolve(null); }
      return withTimeout(p).then(function (obj) {
        if (aborted()) { emit(handle, null); return; }
        var val = (obj && typeof obj === "object") ? obj : null;
        cache.set(handle, val);
        emit(handle, val);
      });
    }
    function worker() {
      if (aborted() || idx >= list.length) return Promise.resolve();
      var h = list[idx++];
      return one(h).then(worker);
    }
    var workers = [];
    for (var w = 0; w < Math.min(concurrency, list.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () {});
  }

  return {
    MAX_QUERY_LEN: MAX_QUERY_LEN,
    MAX_FILTER_VALUES: MAX_FILTER_VALUES,
    MAX_FILTER_STR: MAX_FILTER_STR,
    MAX_PRICE: MAX_PRICE,
    SORTS: SORTS,
    IGNORE_KINDS: IGNORE_KINDS,
    MULTI_KEYS: MULTI_KEYS,
    parseState: parseState,
    serializeState: serializeState,
    buildProxyUrl: buildProxyUrl,
    toSameSitePath: toSameSitePath,
    isSafeImageUrl: isSafeImageUrl,
    formatPrice: formatPrice,
    consentAllowsAnalytics: consentAllowsAnalytics,
    sanitizeToken: sanitizeToken,
    decideFallback: decideFallback,
    comboboxKey: comboboxKey,
    makeDebouncer: makeDebouncer,
    MAX_RECENT: MAX_RECENT,
    normalizeRef: normalizeRef,
    parseRecentIds: parseRecentIds,
    pushRecentId: pushRecentId,
    serializeRecentIds: serializeRecentIds,
    cartAddUrl: cartAddUrl,
    isNumericId: isNumericId,
    newSessionId: newSessionId,
    cleanAnalyticsEvent: cleanAnalyticsEvent,
    // Phase 13.1 — PII guard + interest suggestions (client-only, consent-gated)
    canonicalizeForPII: canonicalizeForPII,
    redactPII: redactPII,
    isLikelyPII: isLikelyPII,
    INTEREST_KEY: INTEREST_KEY,
    INTEREST_MAX_RECENT: INTEREST_MAX_RECENT,
    INTEREST_MAX_KEYS: INTEREST_MAX_KEYS,
    interestEmpty: interestEmpty,
    interestCanonical: interestCanonical,
    interestEvict: interestEvict,
    interestDecay: interestDecay,
    interestAddSearch: interestAddSearch,
    interestAddClick: interestAddClick,
    interestReorder: interestReorder,
    interestRead: interestRead,
    interestWrite: interestWrite,
    interestClear: interestClear,
    // Phase 13.3 — client price hydration (same-origin product.js)
    HYDRATE_MAX_CARDS: HYDRATE_MAX_CARDS,
    HYDRATE_CONCURRENCY: HYDRATE_CONCURRENCY,
    HYDRATE_TIMEOUT_MS: HYDRATE_TIMEOUT_MS,
    currencyFractionDigits: currencyFractionDigits,
    currencyHydrationEligible: currencyHydrationEligible,
    formatMoneyMinor: formatMoneyMinor,
    parseProductJsPrices: parseProductJsPrices,
    hydratedPriceString: hydratedPriceString,
    runHydration: runHydration,
    // Phase 13.2 — locale resolver + Intl plural/date
    SUPPORTED_LOCALES: SUPPORTED_LOCALES,
    baseLanguage: baseLanguage,
    resolveLocale: resolveLocale,
    localeDir: localeDir,
    applyLocaleToRoot: applyLocaleToRoot,
    pluralCategory: pluralCategory,
    formatCount: formatCount,
    formatDateInTz: formatDateInTz,
  };
});
