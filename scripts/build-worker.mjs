// Bundle the background worker to plain JS so the runtime image needs only
// production dependencies (no vite/vite-node/tsconfig-paths at runtime).
// The `~` alias is resolved at build time; node_modules stay external and are
// resolved at runtime from the installed production dependencies.
//
//   npm run worker:build   (build, needs dev deps)
//   npm run worker         (run:  node build/worker/run-worker.js, prod deps only)
import { build } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

await build({
  configFile: false,
  logLevel: "warn",
  plugins: [tsconfigPaths()],
  ssr: { noExternal: [] }, // keep all node_modules external
  build: {
    ssr: true,
    outDir: "build/worker",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: {
      input: "app/lib/jobs/run-worker.ts",
      output: { entryFileNames: "run-worker.js", format: "esm" },
    },
  },
});
console.log("worker bundled -> build/worker/run-worker.js");
