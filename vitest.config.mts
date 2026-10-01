import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Two separate projects so unit and integration suites can run independently:
//   npm run test:unit        -> vitest run --project unit
//   npm run test:integration -> vitest run --project integration
// Machine-readable output: append `-- --reporter=json --outputFile=<path>`.
// No `passWithNoTests`: an empty suite must not be reported as a pass.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Integration tests share one in-process database per file.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Test-only auth helper (tests/support/test-auth.ts, DP8) refuses
          // to run unless explicitly enabled. Never set outside tests.
          env: { ENABLE_TEST_AUTH: "1" },
        },
      },
    ],
  },
});
