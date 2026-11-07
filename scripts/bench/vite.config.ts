import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
// Minimal config for `npm run bench` so vite-node does NOT load the React
// Router plugin (whose dev server restricts fs access to the app root and
// blocks scripts/). Only path-alias resolution is needed here.
export default defineConfig({
  plugins: [tsconfigPaths() as never],
  server: { fs: { allow: [process.cwd()] } },
});
