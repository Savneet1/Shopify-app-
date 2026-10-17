import { type RouteConfig, index, route } from "@react-router/dev/routes";

// Explicit route table (the fs-routes convention package is not a dependency).
export default [
  index("routes/_index.tsx"),

  // Managed-install / token-exchange auth splat.
  route("auth/*", "routes/auth.$.tsx"),

  // Embedded admin surface.
  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
    route("sync", "routes/app.sync.tsx"),
    // Phase 7: storefront install & status page.
    route("storefront", "routes/app.storefront.tsx"),
    // Admin feature pages (Phases 3–6). These files existed but were not
    // registered here; Phase 7 wires them so they are reachable (see
    // docs/PHASE7_REPORT.md "Corrections").
    route("search", "routes/app.search.tsx"),
    route("attributes", "routes/app.attributes.tsx"),
    route("redirects", "routes/app.redirects.tsx"),
    route("stopwords", "routes/app.stopwords.tsx"),
    route("synonyms", "routes/app.synonyms.tsx"),
    // Phase 8: merchandising, banners, A/B experiments.
    route("merch", "routes/app.merch.tsx"),
    route("banners", "routes/app.banners.tsx"),
    route("experiments", "routes/app.experiments.tsx"),
    // Phase 9: recommendations settings + preview.
    route("recommendations", "routes/app.recommendations.tsx"),
    // Phase 10: bundles.
    route("bundles", "routes/app.bundles.tsx"),
    // Phase 11: analytics dashboard + CSV export.
    route("analytics", "routes/app.analytics.tsx"),
    route("analytics/export", "routes/app.analytics.export.tsx"),
    // Phase 12: back-in-stock + email + pre-order + countdown admin.
    route("restock", "routes/app.restock.tsx"),
    route("restock/export", "routes/app.restock.export.tsx"),
  ]),

  // App Proxy storefront endpoints (Phase 3). Shopify proxies
  // /apps/search/{products|predictive|suggest} to /proxy/{...}. These were also
  // unregistered before Phase 7; the storefront extension depends on them.
  route("proxy/products", "routes/proxy.products.tsx"),
  route("proxy/predictive", "routes/proxy.predictive.tsx"),
  route("proxy/suggest", "routes/proxy.suggest.tsx"),
  // Phase 8: A/B aggregate exposure/click beacon.
  route("proxy/merch-event", "routes/proxy.merch-event.tsx"),
  // Phase 9: recommendations endpoint + aggregate product view/click beacon.
  route("proxy/recommendations", "routes/proxy.recommendations.tsx"),
  route("proxy/rec-event", "routes/proxy.rec-event.tsx"),
  // Phase 10: bundles endpoint + aggregate bundle view/add-to-cart beacon.
  route("proxy/bundles", "routes/proxy.bundles.tsx"),
  route("proxy/bundle-event", "routes/proxy.bundle-event.tsx"),
  // Phase 11: analytics ingestion beacon.
  route("proxy/analytics-event", "routes/proxy.analytics-event.tsx"),
  // Phase 12: back-in-stock capture + countdown + pre-order data (App Proxy).
  route("proxy/back-in-stock", "routes/proxy.back-in-stock.tsx"),
  route("proxy/countdown", "routes/proxy.countdown.tsx"),
  route("proxy/preorder", "routes/proxy.preorder.tsx"),

  // Phase 12: public double-opt-in confirm + unsubscribe (no login; from email).
  route("restock/confirm", "routes/restock.confirm.tsx"),
  route("restock/unsubscribe", "routes/restock.unsubscribe.tsx"),

  // Webhooks.
  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.tsx"),
  route("webhooks/app/scopes_update", "routes/webhooks.app.scopes_update.tsx"),
  route("webhooks/compliance", "routes/webhooks.compliance.tsx"),
  route("webhooks/catalog", "routes/webhooks.catalog.tsx"),
  route(
    "webhooks/bulk-operations-finish",
    "routes/webhooks.bulk-operations-finish.tsx",
  ),
] satisfies RouteConfig;
