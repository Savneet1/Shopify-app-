import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // Cast avoids a spurious dual-Vite type clash between vite and vitest's
  // bundled vite types; runtime behaviour is unaffected.
  plugins: [tsconfigPaths() as never],
  test: {
    // Security/DB tests run in Node against a real PostgreSQL instance.
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    // RLS/tenant tests share one database; run serially to keep
    // SET LOCAL / transaction semantics deterministic.
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 30000,
    testTimeout: 30000,
    setupFiles: ["test/setup.ts"],
  },
});
