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
    decideFallback: decideFallback,
    comboboxKey: comboboxKey,
    makeDebouncer: makeDebouncer,
  };
});
