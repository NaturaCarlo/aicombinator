import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
    exclude: ["tests/api/**/*.test.ts", "tests/e2e/**/*.spec.ts"],
    passWithNoTests: true,
  },
});
