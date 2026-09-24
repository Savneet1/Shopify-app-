import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Shopify embedded apps are served over HTTPS via the CLI tunnel in development.
// The CLI sets HOST/SHOPIFY_APP_URL; we derive the HMR/allowed host from it.
const host = new URL(
  process.env.SHOPIFY_APP_URL || "http://localhost:3000",
).hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 };
} else {
  hmrConfig = { protocol: "wss", host, port: parseInt(process.env.FRONTEND_PORT!) || 8002, clientPort: 443 };
}

export default defineConfig({
  server: {
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: { allow: ["app", "node_modules"] },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: { assetsInlineLimit: 0 },
});
