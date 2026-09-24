import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { getPrisma } from "~/db.server";

/**
 * Central Shopify app configuration.
 *
 *  - Auth model: Shopify managed installation / token exchange (the default and
 *    recommended embedded strategy in the React Router package). No custom
 *    OAuth code exchange routes are needed.
 *  - API version: 2026-07 (latest STABLE, verified 2026-09-19). 2026-10 is only
 *    a release candidate and is intentionally not used in production.
 *  - Scopes: Phase 1 requests none (empty). Managed install still requires the
 *    field to be present in shopify.app.toml.
 *  - Session storage: Prisma-backed, connecting as the app_runtime role.
 */
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: (process.env.SCOPES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(getPrisma()),
  distribution: AppDistribution.AppStore,
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
