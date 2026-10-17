/*
 * boost-bundle.js — Phase 10 storefront glue for the Bundle app block.
 * Framework-free; renders with textContent + DOM node APIs only (never raw
 * markup from API data). Pure logic lives in boost-core.js.
 *
 * Honesty + safety:
 *  - shows the sum of REGULAR prices only (this app applies no discount);
 *  - adds to cart via the theme Ajax Cart API using VALIDATED NUMERIC variant
 *    ids only (Core.isNumericId), with hidden _bundle_id/_bundle_slot line
 *    properties so a future Function/analytics can group the lines;
 *  - the cart API's behaviour on a partially-failing items[] is NOT assumed to
 *    be atomic (Requires Verification) — on any non-OK response we show a clear
 *    localized error and do not claim what was added;
 *  - on unavailable/empty/failed load the widget renders nothing (reserved space
 *    collapses) — it never breaks the product or cart page.
 */
(function () {
  var Core = (typeof window !== "undefined" && window.BoostSearch) || null;
  if (!Core || typeof document === "undefined") return;

  function readConfigs() {
    var out = [];
    var nodes = document.querySelectorAll('script[id^="boost-bundle-config-"]');
    for (var i = 0; i < nodes.length; i++) {
      try { out.push(JSON.parse(nodes[i].textContent || "{}")); } catch (e) { /* skip */ }
    }
    return out;
  }
  function currentHost() { try { return window.location && window.location.hostname; } catch (e) { return ""; } }
  function shopifyRoot() {
    try { return (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/"; } catch (e) { return "/"; }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function label(cfg, k, dflt) { return (cfg.labels && cfg.labels[k]) || dflt; }

  function beacon(cfg, bundleId, type) {
    if (!bundleId) return;
    var u = String(cfg.proxyBase || "/apps/search").replace(/\/+$/, "") +
      "/bundle-event?bundle=" + encodeURIComponent(bundleId) + "&type=" + encodeURIComponent(type);
    try {
      if (navigator && typeof navigator.sendBeacon === "function") navigator.sendBeacon(u);
      else fetch(u, { method: "POST", keepalive: true }).catch(function () {});
    } catch (e) { /* beacons never block the UI */ }
  }

  function fetchJson(url, timeoutMs) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, Math.max(500, Math.min(Number(timeoutMs) || 2000, 5000)));
    return fetch(url, { signal: controller ? controller.signal : undefined, headers: { Accept: "application/json" } })
      .then(function (res) { clearTimeout(timer); if (!res.ok) return { __fail: true }; return res.json().then(function (b) { return { body: b }; }, function () { return { __fail: true }; }); })
      .catch(function () { clearTimeout(timer); return { __fail: true }; });
  }

  function money(cfg, amount) {
    return Core.formatPrice(amount, amount, cfg.currency) || "";
  }

  function initBundle(cfg) {
    var root = document.getElementById(cfg.rootId);
    if (!root) return;
    var itemsEl = root.querySelector("[data-boost-bundle-items]");
    var totalEl = root.querySelector("[data-boost-bundle-total]");
    var addBtn = root.querySelector("[data-boost-bundle-add]");
    var statusEl = root.querySelector("[data-boost-bundle-status]");
    if (!itemsEl || !addBtn) return;

    var base = String(cfg.proxyBase || "/apps/search").replace(/\/+$/, "");
    // Prefer the product GID (stable identity); fall back to the handle. The API
    // resolves either to the same product, so a gid-slot bundle still matches a
    // handle page and vice versa (M1).
    var productRef = cfg.seedGid || cfg.seed;
    var url;
    if (cfg.bundleId) url = base + "/bundles?bundle=" + encodeURIComponent(cfg.bundleId);
    else if (productRef) url = base + "/bundles?product=" + encodeURIComponent(productRef) + "&limit=1";
    else return; // nothing to anchor to

    fetchJson(url, cfg.timeoutMs).then(function (r) {
      if (!r || r.__fail) return;
      if (Core.decideFallback({ body: r.body })) return;
      var bundles = (r.body && Array.isArray(r.body.bundles)) ? r.body.bundles : [];
      if (bundles.length === 0) return;              // unavailable → render nothing
      render(cfg, bundles[0], root, itemsEl, totalEl, addBtn, statusEl);
      root.hidden = false;
      beacon(cfg, bundles[0].id, "view");
    });
  }

  function render(cfg, bundle, root, itemsEl, totalEl, addBtn, statusEl) {
    var isMix = bundle.bundleType === "mix_and_match";
    var pickN = Number(bundle.mixPickCount) || 0;
    var rows = [];

    bundle.items.forEach(function (item, idx) {
      var row = el("div", "boost-bundle__item");
      var state = { include: isMix ? idx < pickN : true, select: null, check: null };

      if (isMix) {
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = state.include;
        cb.className = "boost-bundle__pick";
        cb.setAttribute("aria-label", (item.product.title || "") + " — include");
        cb.addEventListener("change", function () { state.include = cb.checked; recomputeTotal(); });
        state.check = cb;
        row.appendChild(cb);
      }

      // image (validated; decorative/alt only)
      if (item.product.image && Core.isSafeImageUrl(item.product.image.url, cfg.imageHosts)) {
        var img = el("img", "boost-bundle__img");
        img.setAttribute("src", item.product.image.url);
        img.setAttribute("alt", item.product.image.alt || item.product.title || "");
        img.setAttribute("loading", "lazy");
        row.appendChild(img);
      }

      var info = el("div", "boost-bundle__info");
      // title as a same-site link when possible, else plain text
      var href = Core.toSameSitePath(item.product.url, cfg.allowedHosts, currentHost());
      if (href) { var a = el("a", "boost-bundle__title", item.product.title || ""); a.setAttribute("href", href); info.appendChild(a); }
      else info.appendChild(el("div", "boost-bundle__title", item.product.title || ""));
      // Phase 12.4: additive pre-order badge (textContent; only when the card
      // payload carries a matched rule — byte-identical otherwise).
      if (item.product.preorder && item.product.preorder.preorder === true) {
        info.appendChild(el("div", "boost-bundle__preorder", String(item.product.preorder.message || "Pre-order")));
      }
      if (cfg.showVendor && item.product.vendor) info.appendChild(el("div", "boost-bundle__vendor", item.product.vendor));
      info.appendChild(el("div", "boost-bundle__qty", "×" + item.quantity));

      // variant selector (customer_picks) or a single fixed variant
      var opts = (item.variants || []).filter(function (v) { return Core.isNumericId(v.variantId); });
      if (item.variantMode === "customer_picks" && opts.length > 1) {
        var sel = document.createElement("select");
        sel.className = "boost-bundle__variant";
        sel.setAttribute("aria-label", (item.product.title || "") + " — " + label(cfg, "variant", "variant"));
        opts.forEach(function (v) {
          var o = document.createElement("option");
          o.value = v.variantId; o.setAttribute("data-price", v.price == null ? "" : String(v.price));
          o.textContent = (v.title || "") + (v.price != null ? " — " + money(cfg, v.price) : "");
          sel.appendChild(o);
        });
        sel.addEventListener("change", recomputeTotal);
        state.select = sel;
        info.appendChild(sel);
      } else if (opts.length >= 1) {
        // fixed (or single) variant: a static label; the id is still opts[0].
        info.appendChild(el("div", "boost-bundle__variant-fixed", (opts[0].title || "") + (opts[0].price != null ? " — " + money(cfg, opts[0].price) : "")));
        state.select = { value: opts[0].variantId, _price: opts[0].price, _fixed: true };
      }
      row.__state = state;
      row.__item = item;
      row.__opts = opts;
      rows.push(row);
      itemsEl.appendChild(row);
    });

    function selectedOption(row) {
      var opts = row.__opts || [];
      var st = row.__state;
      var id = st.select ? (st.select.value != null ? st.select.value : null) : (opts[0] ? opts[0].variantId : null);
      for (var i = 0; i < opts.length; i++) if (opts[i].variantId === id) return opts[i];
      return opts[0] || null;
    }
    function recomputeTotal() {
      var sum = 0; var ok = true;
      rows.forEach(function (row) {
        if (!row.__state.include) return;
        var opt = selectedOption(row);
        if (!opt || opt.price == null) { ok = false; return; }
        sum += Number(opt.price) * row.__item.quantity;
      });
      if (totalEl) totalEl.textContent = label(cfg, "total", "Total") + ": " + (ok ? money(cfg, sum) : "");
    }
    recomputeTotal();

    addBtn.addEventListener("click", function () {
      beacon(cfg, bundle.id, "add_to_cart");
      var chosen = rows.filter(function (r) { return r.__state.include; });
      if (isMix && chosen.length !== pickN) {
        announce(statusEl, (label(cfg, "addError", "Couldn't add the bundle.")));
        return;
      }
      var items = [];
      for (var i = 0; i < chosen.length; i++) {
        var opt = selectedOption(chosen[i]);
        if (!opt || !Core.isNumericId(opt.variantId)) { announce(statusEl, label(cfg, "addError", "Couldn't add the bundle.")); return; }
        items.push({
          id: Number(opt.variantId),
          quantity: chosen[i].__item.quantity,
          properties: { _bundle_id: bundle.id, _bundle_slot: String(chosen[i].__item.position) },
        });
      }
      if (items.length === 0) return;
      announce(statusEl, label(cfg, "adding", "Adding…"));
      addBtn.disabled = true;
      fetch(Core.cartAddUrl(shopifyRoot()), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ items: items }),
      }).then(function (res) {
        addBtn.disabled = false;
        // Do NOT assume atomicity on partial failure (Requires Verification).
        if (res && res.ok) {
          announce(statusEl, label(cfg, "added", "Added to cart."));
          if (cfg.analytics === true) {
            try {
              if (window.BoostAnalytics) {
                window.BoostAnalytics.track(
                  String(cfg.proxyBase || "/apps/search").replace(/\/+$/, ""),
                  { eventType: "bundle_add_to_cart", surface: "bundle" },
                );
              }
            } catch (e) {}
          }
        } else announce(statusEl, label(cfg, "addError", "Couldn't add the bundle."));
      }).catch(function () {
        addBtn.disabled = false;
        announce(statusEl, label(cfg, "addError", "Couldn't add the bundle."));
      });
    });
  }

  function announce(statusEl, msg) {
    if (!statusEl) return;
    statusEl.textContent = "";
    statusEl.textContent = msg;
  }

  function init() {
    var cfgs = readConfigs();
    for (var i = 0; i < cfgs.length; i++) initBundle(cfgs[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
