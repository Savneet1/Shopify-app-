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
  ]),

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
