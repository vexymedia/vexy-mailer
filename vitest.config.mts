import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 30000,
    // The integration suites each drop and rebuild the schema of one shared
    // database, so they must not run against it concurrently.
    fileParallelism: false,
  },
  // tsconfig says jsx: "preserve" because Next compiles JSX itself. The
  // component tests run outside Next, so here it has to be compiled.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
