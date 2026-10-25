import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts", "tests/**/*.test.ts"],
    // P4's tools/approvals tests use node:test; `pnpm test` runs them separately.
    exclude: ["**/node_modules/**", "packages/tools/**", "packages/approvals/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Tests must never see real credentials; config loading in tests uses explicit env objects.
    env: { NODE_ENV: "test" },
  },
});
